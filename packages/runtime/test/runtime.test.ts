import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

import { createSmithersTestEnvironment } from "./helpers/smithers-capability.js";

import {
  appendEvent,
  createInitialRunState,
  getPricingCatalogSnapshotPath,
  layoutForRunRoot,
  readRunState,
  replayEvents,
  writeRunState,
  type RunState
} from "@ultrafuzz/artifacts";
import { CACHE_MANIFEST_FILE, RUN_REFERENCE_MANIFEST_FILE } from "@ultrafuzz/references";

import {
  assertSmithersPackageManifest,
  KIMI_CODE_VERSION,
  renderSmithersPackageJson,
  REQUIRED_SMITHERS_OVERRIDES,
  SMITHERS_EFFECT_VERSION,
  SMITHERS_ORCHESTRATOR_BIN_PATH,
  SMITHERS_ORCHESTRATOR_VERSION
} from "../src/smithers-package.js";
import {
  inspectSmithersRunExistence,
  runSmithersInspectionCommand,
  SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
  submitSmithersWorkflow,
  type CompiledSmithersWorkflow
} from "../src/smithers.js";

import {
  ARTIFACT_RECONCILIATION_CLOCK_SKEW_MS,
  ARTIFACT_RECONCILIATION_GRACE_MS,
  ARTIFACT_RECONCILIATION_MAX_ATTEMPTS,
  ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS,
  AgentPostflightError,
  agentPostflightFailureCode,
  cancelRun,
  forkRun,
  getRunHealth,
  getRunStatus,
  initProject,
  listRuns,
  planRun,
  pauseRun,
  replayRun,
  repairMissingRenderedPromptsForRun,
  readLinkedWorkflowEvidence,
  runAgentWithPostflight,
  resumeRun,
  startRun,
  startSubmissionJournalPath,
  syncRun,
  validateProject
} from "../src/index.js";
import {
  acquireWorkflowMutationLock,
  acquireWorkflowLifecycleActionLock,
  prepareWorkflowLifecycleAction,
  prepareWorkflowRunLink,
  transitionWorkflowLifecycleAction,
  verifyCommittedWorkflowRunLink,
  workflowLifecycleCorrelationLabel,
  workflowLifecycleActionJournalPath,
  workflowRunLinkJournalPath,
  workflowSyncCommitJournalPath,
  WORKFLOW_CHECKPOINT_FRAME_MAX
} from "../src/workflow-mutation.js";
import {
  materializeWorkflowExecutionSnapshot,
  verifyWorkflowControlSnapshot,
  workflowControlGeneration
} from "../src/workflow-integrity.js";
import { withLinkedWorkflowExecution } from "../src/workflow-sync.js";
import { sha256Stable } from "../src/utils.js";

const runningUnderBun = typeof process.versions.bun === "string";
const testArtifactsModuleUrl = pathToFileURL(createRequire(import.meta.url).resolve("@ultrafuzz/artifacts")).href;

async function terminalDispositionForRunRoot(runRoot: string): Promise<{
  kind: "clean" | "genuine-task-failures" | "incomplete" | "operational-failure";
}> {
  const modulePath = path.resolve(process.cwd(), "../evals/dist/terminal-disposition.js");
  const module = (await import(pathToFileURL(modulePath).href)) as {
    inspectTerminalDispositionAtRunRoot(value: string): {
      kind: "clean" | "genuine-task-failures" | "incomplete" | "operational-failure";
    };
  };
  return module.inspectTerminalDispositionAtRunRoot(runRoot);
}

function tempProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-"));
  execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Ultrafuzz Test"], { cwd: project, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "ultrafuzz-test@example.com"], {
    cwd: project,
    stdio: "ignore"
  });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: project, stdio: "ignore" });
  return project;
}

async function waitForPath(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function exactFileTree(root: string): Array<{ path: string; bytes: string }> {
  const entries: Array<{ path: string; bytes: string }> = [];
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) {
        entries.push({
          path: path.relative(root, candidate).split(path.sep).join("/"),
          bytes: fs.readFileSync(candidate).toString("base64")
        });
      } else if (entry.isSymbolicLink()) {
        entries.push({
          path: path.relative(root, candidate).split(path.sep).join("/"),
          bytes: `symlink:${fs.readlinkSync(candidate)}`
        });
      }
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function workflowExecutionSnapshotCount(runRoot: string): number {
  const snapshotsRoot = path.join(runRoot, "smithers", "execution-snapshots");
  return fs.existsSync(snapshotsRoot) ? fs.readdirSync(snapshotsRoot).length : 0;
}

async function observeWorkflowExecutionSnapshotDisposals<T>(
  runRoot: string,
  operation: () => Promise<T>,
  onDispose: (snapshotRoot: string) => void
): Promise<T> {
  const snapshotsRoot = path.join(runRoot, "smithers", "execution-snapshots");
  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "rmdirSync")!;
  const originalRmdirSync = fs.rmdirSync;
  Object.defineProperty(fs, "rmdirSync", {
    ...originalDescriptor,
    value: (...args: unknown[]) => {
      const candidate = String(args[0]);
      let resolved: string | undefined;
      try {
        resolved = fs.realpathSync(candidate);
      } catch {
        // Let the real operation preserve its native missing/replacement error.
      }
      if (resolved !== undefined && path.dirname(resolved) === snapshotsRoot) {
        onDispose(resolved);
      }
      return Reflect.apply(originalRmdirSync, fs, args) as void;
    }
  });
  try {
    return await operation();
  } finally {
    Object.defineProperty(fs, "rmdirSync", originalDescriptor);
  }
}

function eventPayload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function loadGeneratedKimiAgent(project: string): Promise<{
  KimiCode029Agent: new (options: Record<string, unknown>) => {
    issuedSessionId?: string;
    generate(options: Record<string, unknown>): Promise<{ usage?: Record<string, unknown> }>;
    buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
      command?: string;
      args: string[];
      env?: Record<string, string>;
      stdin?: string;
      outputFormat?: string;
      cleanup?: () => Promise<void>;
      benignStderrPatterns: RegExp[];
    }>;
    createOutputInterpreter(): {
      onStdoutLine?: (line: string) => unknown;
      onStderrLine?: (line: string) => unknown;
      onExit?: (result: unknown) => unknown;
    };
  };
}> {
  const fixture = path.join(project, "kimi-agent-executable-test");
  fs.mkdirSync(fixture, { recursive: true });
  const agentsDir = path.join(project, ".smithers", "agents");
  const smithersUrl = pathToFileURL(
    fs.realpathSync(path.join(process.cwd(), "node_modules", "smithers-orchestrator", "src", "index.js"))
  ).href;
  const transpile = (source: string): string =>
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true
      }
    }).outputText;
  const kimiSource = fs
    .readFileSync(path.join(agentsDir, "kimi.ts"), "utf8")
    .replace('from "smithers-orchestrator"', `from ${JSON.stringify(smithersUrl)}`)
    .replace('from "./environment"', 'from "./environment.mjs"')
    .replace('from "./toml"', 'from "./toml.mjs"');
  fs.writeFileSync(path.join(fixture, "kimi.mjs"), transpile(kimiSource), "utf8");
  fs.writeFileSync(
    path.join(fixture, "environment.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "environment.ts"), "utf8")),
    "utf8"
  );
  fs.writeFileSync(
    path.join(fixture, "toml.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "toml.ts"), "utf8")),
    "utf8"
  );
  const kimiModule = (await import(pathToFileURL(path.join(fixture, "kimi.mjs")).href)) as {
    KimiCode029Agent: new (options: Record<string, unknown>) => {
      issuedSessionId?: string;
      generate(options: Record<string, unknown>): Promise<{ usage?: Record<string, unknown> }>;
      buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
        command?: string;
        args: string[];
        env?: Record<string, string>;
        stdin?: string;
        outputFormat?: string;
        cleanup?: () => Promise<void>;
        benignStderrPatterns: RegExp[];
      }>;
      createOutputInterpreter(): {
        onStdoutLine?: (line: string) => unknown;
        onStderrLine?: (line: string) => unknown;
        onExit?: (result: unknown) => unknown;
      };
    };
  };
  return { KimiCode029Agent: kimiModule.KimiCode029Agent };
}

async function loadGeneratedCodexAgent(project: string): Promise<{
  CompatibleCodexAgent: new (options?: Record<string, unknown>) => {
    buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
      args: string[];
      cleanup?: () => Promise<void>;
    }>;
  };
}> {
  const fixture = path.join(project, "codex-agent-executable-test");
  fs.mkdirSync(fixture, { recursive: true });
  const agentsDir = path.join(project, ".smithers", "agents");
  const smithersUrl = pathToFileURL(
    fs.realpathSync(path.join(process.cwd(), "node_modules", "smithers-orchestrator", "src", "index.js"))
  ).href;
  const transpile = (source: string): string =>
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true
      }
    }).outputText;
  const codexSource = fs
    .readFileSync(path.join(agentsDir, "codex.ts"), "utf8")
    .replace('from "smithers-orchestrator"', `from ${JSON.stringify(smithersUrl)}`)
    .replace('from "./environment"', 'from "./environment.mjs"')
    .replace('from "./toml"', 'from "./toml.mjs"');
  fs.writeFileSync(path.join(fixture, "codex.mjs"), transpile(codexSource), "utf8");
  fs.writeFileSync(
    path.join(fixture, "environment.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "environment.ts"), "utf8")),
    "utf8"
  );
  fs.writeFileSync(
    path.join(fixture, "toml.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "toml.ts"), "utf8")),
    "utf8"
  );
  const codexModule = (await import(pathToFileURL(path.join(fixture, "codex.mjs")).href)) as {
    CompatibleCodexAgent: new (options?: Record<string, unknown>) => {
      buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
        args: string[];
        cleanup?: () => Promise<void>;
      }>;
    };
  };
  return { CompatibleCodexAgent: codexModule.CompatibleCodexAgent };
}

async function loadGeneratedDeepSeekAgent(project: string): Promise<{
  createDeepSeekAgent: (options?: Record<string, unknown>) => {
    buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
      command?: string;
      args: string[];
      env?: Record<string, string>;
      outputFormat?: string;
    }>;
  };
  DeepSeekClaudeCodeAgent: new (options: Record<string, unknown>) => {
    generate(options: Record<string, unknown>): Promise<{
      usage?: Record<string, unknown>;
      response?: { modelId?: string };
    }>;
    stream(options: Record<string, unknown>): Promise<{
      usage?: Promise<Record<string, unknown>>;
      totalUsage?: Promise<Record<string, unknown>>;
      response?: Promise<{ modelId?: string }>;
    }>;
    buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
      command?: string;
      args: string[];
      env?: Record<string, string>;
      outputFormat?: string;
    }>;
    createOutputInterpreter(): {
      onStdoutLine?: (line: string) => unknown;
      onExit?: (result: unknown) => unknown;
    };
  };
}> {
  const fixture = path.join(project, "deepseek-agent-executable-test");
  fs.mkdirSync(fixture, { recursive: true });
  const agentsDir = path.join(project, ".smithers", "agents");
  const smithersUrl = pathToFileURL(
    fs.realpathSync(path.join(process.cwd(), "node_modules", "smithers-orchestrator", "src", "index.js"))
  ).href;
  const transpile = (source: string): string =>
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true
      }
    }).outputText;
  const deepSeekSource = fs
    .readFileSync(path.join(agentsDir, "deepseek.ts"), "utf8")
    .replace('from "smithers-orchestrator"', `from ${JSON.stringify(smithersUrl)}`)
    .replace('from "./environment"', 'from "./environment.mjs"')
    .replace('from "./toml"', 'from "./toml.mjs"');
  fs.writeFileSync(path.join(fixture, "deepseek.mjs"), transpile(deepSeekSource), "utf8");
  fs.writeFileSync(
    path.join(fixture, "environment.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "environment.ts"), "utf8")),
    "utf8"
  );
  fs.writeFileSync(
    path.join(fixture, "toml.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "toml.ts"), "utf8")),
    "utf8"
  );
  const deepSeekModule = (await import(pathToFileURL(path.join(fixture, "deepseek.mjs")).href)) as {
    createDeepSeekAgent: (options?: Record<string, unknown>) => {
      buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
        command?: string;
        args: string[];
        env?: Record<string, string>;
        outputFormat?: string;
      }>;
    };
    DeepSeekClaudeCodeAgent: new (options: Record<string, unknown>) => {
      generate(options: Record<string, unknown>): Promise<{
        usage?: Record<string, unknown>;
        response?: { modelId?: string };
      }>;
      stream(options: Record<string, unknown>): Promise<{
        usage?: Promise<Record<string, unknown>>;
        totalUsage?: Promise<Record<string, unknown>>;
        response?: Promise<{ modelId?: string }>;
      }>;
      buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
        command?: string;
        args: string[];
        env?: Record<string, string>;
        outputFormat?: string;
      }>;
      createOutputInterpreter(): {
        onStdoutLine?: (line: string) => unknown;
        onExit?: (result: unknown) => unknown;
      };
    };
  };
  return {
    createDeepSeekAgent: deepSeekModule.createDeepSeekAgent,
    DeepSeekClaudeCodeAgent: deepSeekModule.DeepSeekClaudeCodeAgent
  };
}

function deepSeekModelUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0
): Record<string, Record<string, number>> {
  return {
    [model]: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens
    }
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeFakeTimelineHelpers(project: string): { recorder: string; renderer: string } {
  const recorder = path.join(project, "fake-smithers-record-branch.mjs");
  const renderer = path.join(project, "fake-smithers-render-timeline.mjs");
  fs.writeFileSync(
    recorder,
    String.raw`
import fs from "node:fs";

const [timelinePath, parentRunId, frameText, branchLabel, childRunId] = process.argv.slice(2);
const document = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
const root = document?.data?.timeline ?? document?.timeline;
if (!root || typeof root !== "object") throw new Error("fake timeline root is missing");
const findRun = (candidate, runId) => {
  if (!candidate || typeof candidate !== "object") return undefined;
  if (candidate.runId === runId) return candidate;
  for (const child of Array.isArray(candidate.children) ? candidate.children : []) {
    const found = findRun(child, runId);
    if (found) return found;
  }
  return undefined;
};
const parent = findRun(root, parentRunId);
if (!parent) throw new Error("fake timeline parent is missing");
const frameNo = Number(frameText);
const frame = (Array.isArray(parent.frames) ? parent.frames : []).find((candidate) => candidate?.frameNo === frameNo);
if (!frame) throw new Error("fake timeline source frame is missing");
frame.forks = Array.isArray(frame.forks) ? frame.forks : [];
if (!frame.forks.some((candidate) => candidate?.runId === childRunId)) {
  frame.forks.push({ runId: childRunId, branchLabel });
}
parent.children = Array.isArray(parent.children) ? parent.children : [];
if (!findRun(root, childRunId)) {
  parent.children.push({
    runId: childRunId,
    branch: branchLabel,
    frames: (Array.isArray(parent.frames) ? parent.frames : []).map((candidate) => ({
      frameNo: candidate.frameNo,
      forks: []
    })),
    children: []
  });
}
fs.writeFileSync(timelinePath, JSON.stringify(document, null, 2) + "\n");
`,
    "utf8"
  );
  fs.writeFileSync(
    renderer,
    String.raw`
import fs from "node:fs";

const [timelinePath, requestedRunId] = process.argv.slice(2);
const document = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
const root = document?.data?.timeline ?? document?.timeline;
if (!root || typeof root !== "object") throw new Error("fake timeline root is missing");
if (typeof root.runId !== "string") {
  root.runId = requestedRunId;
  fs.writeFileSync(timelinePath, JSON.stringify(document, null, 2) + "\n");
}
const findRun = (candidate, runId) => {
  if (!candidate || typeof candidate !== "object") return undefined;
  if (candidate.runId === runId) return candidate;
  for (const child of Array.isArray(candidate.children) ? candidate.children : []) {
    const found = findRun(child, runId);
    if (found) return found;
  }
  return undefined;
};
const selected = findRun(root, requestedRunId);
if (!selected) throw new Error("fake timeline requested run is missing");
process.stdout.write(JSON.stringify({ data: { timeline: selected } }) + "\n");
`,
    "utf8"
  );
  return { recorder, renderer };
}

function fakeInstalledSmithersPaths(project: string): {
  packageRoot: string;
  packageJson: string;
  target: string;
  shim: string;
} {
  const packageRoot = path.join(project, ".smithers", "node_modules", "smithers-orchestrator");
  return {
    packageRoot,
    packageJson: path.join(packageRoot, "package.json"),
    target: path.join(packageRoot, ...SMITHERS_ORCHESTRATOR_BIN_PATH.split("/")),
    shim: path.join(project, ".smithers", "node_modules", ".bin", "smithers")
  };
}

function writeFakeInstalledSmithersDependencies(project: string): void {
  const dependencies = [
    ["@moonshot-ai/kimi-code", KIMI_CODE_VERSION],
    ["@smithers-orchestrator/tool-context", SMITHERS_ORCHESTRATOR_VERSION],
    ["react", "19.2.4"],
    ["zod", "4.4.3"]
  ] as const;
  for (const [name, version] of dependencies) {
    writeFakeInstalledSmithersDependency(project, name, version);
  }
}

function writeFakeInstalledSmithersDependency(project: string, name: string, version: string): void {
  const packageRoot = path.join(project, ".smithers", "node_modules", ...name.split("/"));
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name, version })}\n`, "utf8");
  fs.writeFileSync(path.join(packageRoot, "index.js"), "export {};\n", "utf8");
}

function writeFakeInstalledSmithers(
  project: string,
  input: { version?: string; shimTarget?: string; binTarget?: string } = {}
): ReturnType<typeof fakeInstalledSmithersPaths> {
  const paths = fakeInstalledSmithersPaths(project);
  fs.mkdirSync(path.dirname(paths.target), { recursive: true });
  fs.mkdirSync(path.dirname(paths.shim), { recursive: true });
  fs.writeFileSync(
    paths.packageJson,
    `${JSON.stringify({
      name: "smithers-orchestrator",
      version: input.version ?? SMITHERS_ORCHESTRATOR_VERSION,
      bin: { smithers: input.binTarget ?? SMITHERS_ORCHESTRATOR_BIN_PATH }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    paths.target,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SMITHERS_FAKE_LOG\"\nprintf '%s\\n' '{\"ok\":true}'\n",
    "utf8"
  );
  fs.chmodSync(paths.target, 0o755);
  fs.rmSync(paths.shim, { force: true });
  fs.symlinkSync(path.relative(path.dirname(paths.shim), input.shimTarget ?? paths.target), paths.shim);
  writeFakeInstalledSmithersDependencies(project);
  return paths;
}

function writeFakePnpmInstalledSmithers(project: string): ReturnType<typeof fakeInstalledSmithersPaths> {
  const paths = fakeInstalledSmithersPaths(project);
  const storeRoot = path.join(
    project,
    ".smithers",
    "node_modules",
    ".pnpm",
    "smithers-orchestrator@unit",
    "node_modules",
    "smithers-orchestrator"
  );
  const storePackageJson = path.join(storeRoot, "package.json");
  const storeTarget = path.join(storeRoot, ...SMITHERS_ORCHESTRATOR_BIN_PATH.split("/"));
  fs.mkdirSync(path.dirname(storeTarget), { recursive: true });
  fs.mkdirSync(path.dirname(paths.shim), { recursive: true });
  fs.writeFileSync(
    storePackageJson,
    `${JSON.stringify({
      name: "smithers-orchestrator",
      version: SMITHERS_ORCHESTRATOR_VERSION,
      bin: { smithers: SMITHERS_ORCHESTRATOR_BIN_PATH }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    storeTarget,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SMITHERS_FAKE_LOG\"\nprintf '%s\\n' '{\"ok\":true}'\n",
    "utf8"
  );
  fs.chmodSync(storeTarget, 0o755);
  fs.symlinkSync(path.relative(path.dirname(paths.packageRoot), storeRoot), paths.packageRoot);
  const linkedTarget = path.relative(path.dirname(paths.shim), paths.target).split(path.sep).join("/");
  fs.writeFileSync(paths.shim, `#!/bin/sh\nbasedir=\${0%/*}\nexec "$basedir/${linkedTarget}" "$@"\n`, "utf8");
  fs.chmodSync(paths.shim, 0o755);
  writeFakeInstalledSmithersDependencies(project);
  return paths;
}

function writeFakeNpmInstaller(project: string): {
  binDir: string;
  npmLogPath: string;
  smithersLogPath: string;
} {
  const binDir = path.join(project, "fake-bin");
  const npm = path.join(binDir, "npm");
  const npmLogPath = path.join(project, "npm-install.log");
  const smithersLogPath = path.join(project, "local-smithers.log");
  const paths = fakeInstalledSmithersPaths(project);
  writeFakeInstalledSmithersDependencies(project);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    npm,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellQuote(npmLogPath)}`,
      `mkdir -p ${shellQuote(path.dirname(paths.target))} ${shellQuote(path.dirname(paths.shim))}`,
      `cat > ${shellQuote(paths.packageJson)} <<'EOS'`,
      JSON.stringify({
        name: "smithers-orchestrator",
        version: SMITHERS_ORCHESTRATOR_VERSION,
        bin: { smithers: SMITHERS_ORCHESTRATOR_BIN_PATH }
      }),
      "EOS",
      `cat > ${shellQuote(paths.target)} <<'EOS'`,
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"',
      "printf '%s\\n' '{\"ok\":true}'",
      "EOS",
      `chmod +x ${shellQuote(paths.target)}`,
      `rm -f ${shellQuote(paths.shim)}`,
      `ln -s ${shellQuote(path.relative(path.dirname(paths.shim), paths.target))} ${shellQuote(paths.shim)}`,
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(npm, 0o755);
  return { binDir, npmLogPath, smithersLogPath };
}

function fakeSmithersEnv(
  project: string,
  input: { inspectState?: "running" | "failed" } = {}
): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const timelinePath = path.join(project, "fake-smithers-timeline.json");
  const timelineHelpers = writeFakeTimelineHelpers(project);
  fs.writeFileSync(
    timelinePath,
    `${JSON.stringify(
      {
        timeline: {
          frames: [1, 7, 9, 11, 33, 44].map((frameNo) => ({ frameNo, forks: [] })),
          children: []
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'if [ -n "$SMITHERS_FAKE_LOG" ]; then',
      '  printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_ENV_LOG" ]; then',
      '  printf \'%s|%s|%s\\n\' "$OPENAI_API_KEY" "$AWS_SECRET_ACCESS_KEY" "$FOUNDRY_PROFILE" > "$SMITHERS_FAKE_ENV_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_CLOUD_ENV_LOG" ]; then',
      '  printf \'%s|%s\\n\' "$UFZ_PROVIDER_ONE" "$UFZ_PROVIDER_TWO" > "$SMITHERS_FAKE_CLOUD_ENV_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_KIMI_ENV_LOG" ]; then',
      '  printf \'%s|%s|%s|%s|%s|%s\\n\' "$KIMI_API_KEY" "$MOONSHOT_API_KEY" "$KIMI_BASE_URL" "$ULTRAFUZZ_KIMI_SHARED_AUTH_HOME" "$ULTRAFUZZ_KIMI_SESSION_HOME" "$ULTRAFUZZ_MODAL_REMOTE_ROOT" > "$SMITHERS_FAKE_KIMI_ENV_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_DEEPSEEK_ENV_LOG" ]; then',
      '  printf \'%s|%s\\n\' "$DEEPSEEK_API_KEY" "$ANTHROPIC_API_KEY" > "$SMITHERS_FAKE_DEEPSEEK_ENV_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_PERSISTENT_AUTH_ENV_LOG" ]; then',
      '  printf \'%s|%s|%s\\n\' "$ULTRAFUZZ_PERSISTENT_SUBSCRIPTION_AUTH_PATH" "$ULTRAFUZZ_MODAL_REMOTE_ROOT" "$AWS_SECRET_ACCESS_KEY" > "$SMITHERS_FAKE_PERSISTENT_AUTH_ENV_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_CONTEXT_LOG" ]; then',
      '  printf \'%s|%s|%s|%s|%s|%s\\n\' "$SMITHERS_RUN_ID" "$SMITHERS_NODE_ID" "$SMITHERS_ATTEMPT" "$SMITHERS_ITERATION" "$SMITHERS_CLI_SRC_DIR" "$SMITHERS_SNAPSHOT_SOCK" > "$SMITHERS_FAKE_CONTEXT_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_KEEP_WORKTREES_LOG" ]; then',
      '  printf \'%s\\n\' "$SMITHERS_KEEP_WORKTREES" > "$SMITHERS_FAKE_KEEP_WORKTREES_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_FORGE_GUARD_LOG" ]; then',
      '  command -v forge > "$SMITHERS_FAKE_FORGE_GUARD_LOG"',
      "fi",
      'case "$1" in',
      "  inspect)",
      '    inspect_state="${SMITHERS_FAKE_INSPECT_STATE:-running}"',
      '    printf \'{"ok":true,"data":{"run":{"id":"%s","status":"%s"},"runState":{"runId":"%s","state":"%s"},"steps":[]}}\\n\' "$2" "$inspect_state" "$2" "$inspect_state"',
      "    ;;",
      "  fork)",
      '    source_run_id=""; fork_frame=""; branch_label=""; previous=""',
      '    for argument in "$@"; do',
      '      [ "$previous" != "--run-id" ] || source_run_id="$argument"',
      '      [ "$previous" != "--frame" ] || fork_frame="$argument"',
      '      [ "$previous" != "--label" ] || branch_label="$argument"',
      '      previous="$argument"',
      "    done",
      '    node "$SMITHERS_FAKE_TIMELINE_RECORDER" "$SMITHERS_FAKE_TIMELINE" "$source_run_id" "$fork_frame" "$branch_label" ultrafuzz-lifecycle-run-forked',
      "    printf '%s\\n' '{\"forkedRunId\":\"ultrafuzz-lifecycle-run-forked\"}'",
      "    ;;",
      "  replay)",
      '    source_run_id=""; replay_frame=""; branch_label=""',
      '    previous=""',
      '    for argument in "$@"; do',
      '      [ "$previous" != "--run-id" ] || source_run_id="$argument"',
      '      [ "$previous" != "--frame" ] || replay_frame="$argument"',
      '      [ "$previous" != "--label" ] || branch_label="$argument"',
      '      previous="$argument"',
      "    done",
      '    case "$replay_frame" in ""|*[!0-9]*) printf \'replay requires integer --frame\\n\' >&2; exit 64 ;; esac',
      '    case " $* " in *" --ultrafuzz-prepare-only "*) ;; *) printf \'replay requires prepare-only mode\\n\' >&2; exit 65 ;; esac',
      '    node "$SMITHERS_FAKE_TIMELINE_RECORDER" "$SMITHERS_FAKE_TIMELINE" "$source_run_id" "$replay_frame" "$branch_label" ultrafuzz-lifecycle-run-replayed',
      "    printf '%s\\n' '{\"forkedRunId\":\"ultrafuzz-lifecycle-run-replayed\"}'",
      "    ;;",
      "  timeline)",
      '    node "$SMITHERS_FAKE_TIMELINE_RENDERER" "$SMITHERS_FAKE_TIMELINE" "$2"',
      "    ;;",
      "  pause)",
      '    if [ -n "$SMITHERS_FAKE_PAUSE_EMPTY_SUCCESS" ]; then',
      "      exit 0",
      '    elif [ -n "$SMITHERS_FAKE_ALREADY_PAUSED" ]; then',
      "      printf '%s\\n' '{\"status\":\"paused\"}'",
      "    else",
      "      printf '%s\\n' '{\"status\":\"pause-requested\"}'",
      "      exit 2",
      "    fi",
      "    ;;",
      "  status)",
      '    printf \'%s\\n\' \'{"data":{"status":"running","verdict":"running-healthy","reason":"1 running, 2 finished in last 10m","counts":{"finished":2,"inProgress":1,"pending":3,"failed":0,"waitingApproval":0,"waitingEvent":0,"waitingTimer":0,"skipped":0,"other":0,"total":6},"modelMix":[{"engine":"codex","model":"gpt-test","attempts":3,"quotaParked":false}],"throughput":{"recentFinished":2,"windowMs":600000,"totalFinished":2,"lastFinishedAtMs":1000},"bottleneck":[{"nodeId":"project-discovery","iteration":0,"state":"in-progress","detail":"running 1m"}],"bottleneckOmitted":0,"quota":null,"generatedAtMs":2000}}\'',
      "    ;;",
      "  *)",
      '    printf \'%s\\n\' \'{"ok":true,"smithers":"accepted"}\'',
      "    ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  return createSmithersTestEnvironment(smithers, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_FAKE_LOG: path.join(project, "smithers-commands.log"),
    SMITHERS_FAKE_TIMELINE: timelinePath,
    SMITHERS_FAKE_TIMELINE_RECORDER: timelineHelpers.recorder,
    SMITHERS_FAKE_TIMELINE_RENDERER: timelineHelpers.renderer,
    SMITHERS_FAKE_INSPECT_STATE: input.inspectState
  });
}

function durableStartSmithersEnv(
  project: string,
  input: { holdDuringUp?: boolean } = {}
): Record<string, string | undefined> & {
  SMITHERS_START_EXTERNAL_RUN: string;
  SMITHERS_START_EXTERNAL_CORRELATION: string;
  SMITHERS_START_UP_ATTEMPTS: string;
  SMITHERS_START_HOLD_MARKER?: string;
  SMITHERS_START_HOLD_RELEASE?: string;
} {
  const installed = writeFakeInstalledSmithers(project);
  const smithers = installed.target;
  const externalRun = path.join(project, "durable-start-external-run");
  const externalCorrelation = path.join(project, "durable-start-external-correlation");
  const upAttempts = path.join(project, "durable-start-up-attempts.log");
  const holdMarker = path.join(project, "durable-start-up-held");
  const holdRelease = path.join(project, "durable-start-up-release");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      "set -eu",
      'command_name="$1"',
      "shift",
      'case "$command_name" in',
      "  up)",
      `    printf 'up\\n' >> ${shellQuote(upAttempts)}`,
      '    run_id=""',
      '    started_by_harness=""',
      '    started_by_session=""',
      '    started_by_prompt=""',
      '    previous=""',
      '    for argument in "$@"; do',
      '      if [ "$previous" = "--run-id" ]; then run_id="$argument"; fi',
      '      if [ "$previous" = "--started-by-harness" ]; then started_by_harness="$argument"; fi',
      '      if [ "$previous" = "--started-by-session" ]; then started_by_session="$argument"; fi',
      '      if [ "$previous" = "--started-by-prompt" ]; then started_by_prompt="$argument"; fi',
      '      previous="$argument"',
      "    done",
      "    if [ -z \"$run_id\" ]; then printf 'missing run id\\n' >&2; exit 64; fi",
      `    if [ -f ${shellQuote(externalRun)} ]; then printf 'duplicate external run\\n' >&2; exit 65; fi`,
      `    printf '%s\\n' "$run_id" > ${shellQuote(externalRun)}`,
      `    printf '%s\\n%s\\n%s\\n' "$started_by_harness" "$started_by_session" "$started_by_prompt" > ${shellQuote(externalCorrelation)}`,
      ...(input.holdDuringUp
        ? [
            `    printf 'held\\n' > ${shellQuote(holdMarker)}`,
            `    while [ ! -f ${shellQuote(holdRelease)} ]; do sleep 0.01; done`
          ]
        : []),
      "    printf '%s\\n' '{\"ok\":true,\"accepted\":true}'",
      "    ;;",
      "  inspect)",
      '    requested="$1"',
      '    if [ "${SMITHERS_START_INSPECT_MODE:-}" = "unknown" ]; then',
      "      printf '%s\\n' '{\"ok\":true,\"unbound\":true}'",
      "      exit 0",
      "    fi",
      `    if [ ! -f ${shellQuote(externalRun)} ]; then`,
      '      printf \'%s\\n\' \'{"error":{"code":"RUN_NOT_FOUND"}}\'',
      "      exit 4",
      "    fi",
      `    observed="$(sed -n '1p' ${shellQuote(externalRun)})"`,
      '    if [ "${SMITHERS_START_INSPECT_MODE:-}" = "no-correlation" ]; then',
      `      node -e 'const fs=require("node:fs");const runId=fs.readFileSync(process.argv[1],"utf8").trim();process.stdout.write(JSON.stringify({ok:true,data:{run:{id:runId,status:"running"},runState:{runId,state:"running"},steps:[]}})+"\\n")' ${shellQuote(externalRun)}`,
      "      exit 0",
      "    fi",
      `    node -e 'const fs=require("node:fs");const [runFile,correlationFile]=process.argv.slice(1);const runId=fs.readFileSync(runFile,"utf8").trim();const [harness,sessionId,...promptLines]=fs.readFileSync(correlationFile,"utf8").trimEnd().split("\\n");process.stdout.write(JSON.stringify({ok:true,data:{run:{id:runId,status:"running",startedBy:{harness,sessionId,prompt:promptLines.join("\\n")}},runState:{runId,state:"running"},steps:[]}})+"\\n")' ${shellQuote(externalRun)} ${shellQuote(externalCorrelation)}`,
      '    if [ "$requested" != "$observed" ]; then exit 66; fi',
      "    ;;",
      "  *)",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  return {
    PATH: process.env.PATH,
    SMITHERS_START_EXTERNAL_RUN: externalRun,
    SMITHERS_START_EXTERNAL_CORRELATION: externalCorrelation,
    SMITHERS_START_UP_ATTEMPTS: upAttempts,
    ...(input.holdDuringUp ? { SMITHERS_START_HOLD_MARKER: holdMarker, SMITHERS_START_HOLD_RELEASE: holdRelease } : {})
  };
}

function fakeLifecycleSmithersEnv(
  project: string,
  input: {
    inspect: unknown;
    events?: string;
    tokenEvents?: string;
    refreshedTokenEvents?: string;
    failEvents?: boolean;
    inspectMarkerPath?: string;
    lifecycleStartedMarkerPath?: string;
    lifecycleReleaseMarkerPath?: string;
    pauseStartedMarkerPath?: string;
    pauseReleaseMarkerPath?: string;
    pauseStatus?: "paused" | "pause-requested";
    pauseOutput?: string;
    cancelStartedMarkerPath?: string;
    cancelReleaseMarkerPath?: string;
    cancelStatus?: "cancelled" | "cancel-requested";
    cancelOutput?: string;
    timeline?: unknown;
    replayRunId?: string;
    replayTimelineRunId?: string;
    replayExitCode?: number;
    forkRunId?: string;
    forkTimelineRunId?: string;
    outputOverrides?: Record<string, unknown>;
    outputStartedMarkerPath?: string;
    outputReleaseMarkerPath?: string;
    allowMissingVerifierArtifacts?: boolean;
    inspectExitCode?: number;
    persistedWorkflowPathLog?: string;
  }
): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const inspectPath = path.join(project, "fake-smithers-inspect.json");
  const eventsPath = path.join(project, "fake-smithers-events.ndjson");
  const tokenEventsPath = path.join(project, "fake-smithers-token-events.ndjson");
  const refreshedTokenEventsPath = path.join(project, "fake-smithers-refreshed-token-events.ndjson");
  const tokenReadMarkerPath = path.join(project, "fake-smithers-token-read");
  const timelinePath = path.join(project, "fake-smithers-timeline.json");
  const timelineHelpers = writeFakeTimelineHelpers(project);
  const outputHelperPath = path.join(project, "fake-smithers-output.mjs");
  const outputOverridesPath = path.join(project, "fake-smithers-output-overrides.json");
  fs.writeFileSync(inspectPath, `${JSON.stringify(input.inspect, null, 2)}\n`, "utf8");
  fs.writeFileSync(eventsPath, input.events ?? defaultWorkflowEvents(input.inspect), "utf8");
  fs.writeFileSync(tokenEventsPath, input.tokenEvents ?? input.events ?? "", "utf8");
  if (input.refreshedTokenEvents !== undefined) {
    fs.writeFileSync(refreshedTokenEventsPath, input.refreshedTokenEvents, "utf8");
  }
  fs.writeFileSync(
    timelinePath,
    `${JSON.stringify(input.timeline ?? { timeline: { frames: [] } }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(outputOverridesPath, `${JSON.stringify(input.outputOverrides ?? {})}\n`, "utf8");
  fs.writeFileSync(
    outputHelperPath,
    String.raw`
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [workflowRunId, verifierTaskId, inspectPath, eventsPath, overridesPath] = process.argv.slice(2);
const overrides = JSON.parse(fs.readFileSync(overridesPath, "utf8"));
if (Object.hasOwn(overrides, verifierTaskId)) {
  process.stdout.write(JSON.stringify(overrides[verifierTaskId]) + "\n");
  process.exit(0);
}
const runsRoot = path.join(process.cwd(), ".ultrafuzz", "runs");
const runRoots = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot).map((name) => path.join(runsRoot, name)) : [];
let selected;
for (const runRoot of runRoots) {
  const tasksPath = path.join(runRoot, "smithers", "tasks.json");
  if (!fs.existsSync(tasksPath)) continue;
  const document = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
  if (document.smithers_run_id !== workflowRunId) continue;
  const task = document.tasks.find((entry) => entry.verifierSmithersNodeId === verifierTaskId);
  if (task !== undefined) {
    selected = { runRoot, task, tasks: document.tasks };
    break;
  }
}
if (selected === undefined) throw new Error("fake verifier task is unknown");
const { runRoot, task, tasks } = selected;
const graph = JSON.parse(fs.readFileSync(path.join(runRoot, "graph.json"), "utf8"));
const node = graph.nodes.find((entry) => entry.id === task.concreteNodeId);
if (node === undefined) throw new Error("fake verifier graph node is unknown");
const roots = [task.artifactDir, path.join(task.workspacePath, "artifacts", task.attemptId)];
const locatedArtifact = (output) =>
  roots.map((root) => ({ root, file: path.join(root, output.path) })).find(({ file }) => fs.existsSync(file));
const findingsOutput = node.outputs.find((output) => output.contract === "ultrafuzz/findings@1");
const locatedFindings = findingsOutput === undefined ? undefined : locatedArtifact(findingsOutput);
if (locatedFindings !== undefined) {
  const { normalizeFindings } = await import(process.env.SMITHERS_FAKE_ARTIFACTS_MODULE);
  const model = task.metadata?.model;
  const loop = task.metadata?.loop;
  const findingsStat = fs.lstatSync(locatedFindings.file);
  if (findingsStat.isFile() && findingsStat.nlink === 1) {
    try {
      normalizeFindings({
        artifactDir: locatedFindings.root,
        nodeId: task.attemptId,
        provenance: {
          nodeId: task.attemptId,
          strategy: task.logicalNodeId,
          attemptIndex: model?.attemptIndex ?? loop?.attemptIndex ?? node.loop?.attempt_index,
          modelId: model?.profileId ?? node.model_fanout?.[0]?.model_profile_id,
          model: model?.modelName ?? task.modelName ?? node.model_fanout?.[0]?.model_name,
          modelIndex: model?.modelIndex ?? node.model_fanout?.[0]?.model_index,
          loopIndex: loop?.index ?? node.loop?.index
        }
      });
    } catch {
      // Keep intentionally invalid bytes intact so product synchronization,
      // rather than this fake runner, owns their terminal classification.
    }
  }
}
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => sha(JSON.stringify(value));
const byAttempt = new Map(tasks.map((entry) => [entry.attemptId, entry]));
const closure = new Map();
const visit = (entry) => {
  if (entry === undefined || closure.has(entry.attemptId)) return;
  for (const dependency of entry.dependencies ?? []) visit(byAttempt.get(dependency));
  closure.set(entry.attemptId, entry);
};
visit(task);
const claim = {
  schema_version: "ultrafuzz.workspace-source-attestation.v1",
  target_revision: task.baseCommit,
  task_count: closure.size,
  tasks: [...closure.values()].map((entry) => ({
    attempt_id: entry.attemptId,
    node_id: entry.logicalNodeId,
    expected_base_commit: entry.baseCommit,
    initial_head: entry.baseCommit,
    agent_root_verified: true,
    source_tree: entry.baseCommit,
    tracked_clean: true
  })).sort((left, right) => left.attempt_id.localeCompare(right.attempt_id))
};
fs.mkdirSync(task.artifactDir, { recursive: true });
fs.writeFileSync(path.join(task.artifactDir, "ultrafuzz-workspace-source-claim.json"), JSON.stringify(claim, null, 2) + "\n");
const artifacts = node.outputs.map((output) => {
  const located = locatedArtifact(output);
  let contents;
  if (located !== undefined) {
    contents = fs.readFileSync(located.file);
  } else if (process.env.SMITHERS_FAKE_ALLOW_MISSING_ARTIFACTS === "1") {
    if (output.contract === "ultrafuzz/nonempty-markdown@1") {
      contents = Buffer.from("artifact for " + task.attemptId + "\n", "utf8");
    } else if (output.contract === "ultrafuzz/findings@1") {
      const model = task.metadata?.model;
      const loop = task.metadata?.loop;
      contents = Buffer.from(JSON.stringify([{
        schema_version: "1.0",
        id: "finding-" + task.attemptId,
        title: "Candidate issue",
        status: "candidate",
        severity_guess: "medium",
        confidence: "medium",
        summary: "The generated evidence needs review.",
        source_node_id: task.attemptId,
        strategy: task.logicalNodeId,
        attempt_index: model?.attemptIndex ?? loop?.attemptIndex ?? node.loop?.attempt_index,
        model_id: model?.profileId ?? node.model_fanout?.[0]?.model_profile_id,
        model: model?.modelName ?? task.modelName ?? node.model_fanout?.[0]?.model_name,
        model_index: model?.modelIndex ?? node.model_fanout?.[0]?.model_index,
        loop_index: loop?.index ?? node.loop?.index
      }], null, 2) + "\n", "utf8");
    } else {
      throw new Error("fake verified artifact fixture is unsupported: " + output.contract);
    }
  } else {
    throw new Error("fake verified artifact is missing: " + output.path);
  }
  return {
    path: output.path,
    contract: output.contract,
    contract_digest: output.contract_digest,
    sha256: sha(contents),
    primary: output.primary
  };
});
const primaryArtifact = artifacts.find((artifact) => artifact.primary)?.path;
if (primaryArtifact === undefined) throw new Error("fake primary artifact is missing");
const artifactSetDigest = canonical({ artifacts, primary_artifact: primaryArtifact });
const requestFingerprint = canonical([workflowRunId, task.smithersNodeId, task.attemptId, task.baseCommit]);
const executionIdentity = canonical([workflowRunId, requestFingerprint, artifactSetDigest]);
const executor = {
  schema_version: "ultrafuzz.executor-result.v1",
  execution_mode: "local",
  workflow_run_id: workflowRunId,
  agent_task_id: task.smithersNodeId,
  agent_iteration: 0,
  agent_attempt: 0,
  strategy_attempt_id: task.attemptId,
  workflow_execution_id: "execution-pending",
  controller_invocation_id: "controller-pending",
  checkpoint_generation_id: "checkpoint-pending",
  executor_retry_id: "retry-pending",
  execution_identity: executionIdentity,
  request_fingerprint: requestFingerprint,
  executor_result_digest: artifactSetDigest
};
const inspect = JSON.parse(fs.readFileSync(inspectPath, "utf8"));
const steps = inspect.data?.steps ?? inspect.steps ?? [];
const step = steps.find((entry) => (entry.id ?? entry.nodeId) === verifierTaskId);
const agentStep = steps.find((entry) => (entry.id ?? entry.nodeId) === task.smithersNodeId);
const events = fs.readFileSync(eventsPath, "utf8").split(/\r?\n/u).flatMap((line) => {
  if (line.trim().length === 0) return [];
  try { return [JSON.parse(line)]; } catch { return []; }
});
const eventNodeId = (event) => event.payload?.nodeId ?? event.nodeId;
const verifierEventIndex = events.findLastIndex(
  (event) => event.type === "NodeFinished" && eventNodeId(event) === verifierTaskId
);
const agentEvents = events.slice(0, verifierEventIndex < 0 ? events.length : verifierEventIndex);
const agentEventIndex = agentEvents.findLastIndex(
  (event) => event.type === "NodeFinished" && eventNodeId(event) === task.smithersNodeId
);
const agentEvent = agentEventIndex < 0 ? undefined : agentEvents[agentEventIndex];
const verifierEvent = verifierEventIndex < 0 ? undefined : events[verifierEventIndex];
executor.agent_iteration = Number.isSafeInteger(agentEvent?.payload?.iteration)
  ? agentEvent.payload.iteration
  : Number.isSafeInteger(agentStep?.iteration) ? agentStep.iteration : 0;
executor.agent_attempt = Number.isSafeInteger(agentEvent?.payload?.attempt)
  ? agentEvent.payload.attempt
  : Number.isSafeInteger(agentStep?.attempt) ? agentStep.attempt : 0;
const matchingAgentStart = agentEventIndex < 0 ? undefined : agentEvents
  .slice(0, agentEventIndex + 1)
  .findLast((event) =>
    event.type === "NodeStarted" &&
    eventNodeId(event) === task.smithersNodeId &&
    (event.payload?.attempt ?? 0) === executor.agent_attempt &&
    (event.payload?.iteration ?? 0) === executor.agent_iteration
  );
const dimensionField = (payload, camel, snake) => {
  const value = payload?.[camel] ?? payload?.[snake];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};
const stableDimension = (prefix, parts) => prefix + "-" + canonical(parts).slice(0, 32);
const controllerEvent = agentEventIndex < 0 ? undefined : agentEvents
  .slice(0, agentEventIndex + 1)
  .findLast((event) => ["RunStarted", "RunAutoResumed", "RunHijacked", "ReplayStarted", "RunForked"].includes(event.type));
executor.controller_invocation_id =
  dimensionField(matchingAgentStart?.payload, "controllerInvocationId", "controller_invocation_id") ??
  dimensionField(controllerEvent?.payload, "controllerInvocationId", "controller_invocation_id") ??
  workflowRunId;
executor.workflow_execution_id =
  dimensionField(matchingAgentStart?.payload, "workflowExecutionId", "workflow_execution_id") ??
  stableDimension("execution", [workflowRunId, executor.controller_invocation_id]);
executor.checkpoint_generation_id =
  dimensionField(matchingAgentStart?.payload, "checkpointGenerationId", "checkpoint_generation_id") ??
  stableDimension("checkpoint", [executor.workflow_execution_id, String(executor.agent_iteration)]);
executor.executor_retry_id =
  dimensionField(matchingAgentStart?.payload, "executorRetryId", "executor_retry_id") ??
  stableDimension("retry", [
    workflowRunId,
    task.attemptId,
    String(agentEvent?.seq ?? (Number.isFinite(agentEvent?.timestampMs) ? new Date(agentEvent.timestampMs).toISOString() : "")),
    String(executor.agent_attempt)
  ]);
const attempt = Number.isSafeInteger(verifierEvent?.payload?.attempt)
  ? verifierEvent.payload.attempt
  : Number.isSafeInteger(step?.attempt) ? step.attempt : 0;
const iteration = Number.isSafeInteger(verifierEvent?.payload?.iteration)
  ? verifierEvent.payload.iteration
  : Number.isSafeInteger(step?.iteration) ? step.iteration : 0;
const verifier = {
  workflow_run_id: workflowRunId,
  verifier_task_id: verifierTaskId,
  iteration,
  attempt,
  verification_identity: canonical({
    executor,
    verifier_task_id: verifierTaskId,
    iteration,
    attempt,
    artifact_set_digest: artifactSetDigest
  })
};
process.stdout.write(JSON.stringify({
  schema_version: "ultrafuzz.verification-output.v2",
  executor,
  verifier,
  artifacts,
  primary_artifact: primaryArtifact,
  artifact_set_digest: artifactSetDigest
}) + "\n");
`,
    "utf8"
  );
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'if [ -n "$SMITHERS_FAKE_LOG" ]; then',
      '  printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_PERSISTED_WORKFLOW_PATH_LOG" ]; then',
      '  printf \'%s|%s\\n\' "$*" "$ULTRAFUZZ_WORKFLOW_PERSISTED_PATH" >> "$SMITHERS_FAKE_PERSISTED_WORKFLOW_PATH_LOG"',
      "fi",
      'case "$1" in',
      "  inspect)",
      ...(input.inspectMarkerPath === undefined ? [] : [`    touch ${shellQuote(input.inspectMarkerPath)}`]),
      '    cat "$SMITHERS_FAKE_INSPECT"',
      ...(input.inspectExitCode === undefined ? [] : [`    exit ${input.inspectExitCode}`]),
      "    ;;",
      "  cancel)",
      ...(input.cancelStartedMarkerPath === undefined || input.cancelReleaseMarkerPath === undefined
        ? []
        : [
            `    printf '%s\\n' "$$" > ${shellQuote(input.cancelStartedMarkerPath)}`,
            `    while [ ! -e ${shellQuote(input.cancelReleaseMarkerPath)} ]; do sleep 0.01; done`
          ]),
      `    printf '%s\\n' ${shellQuote(input.cancelOutput ?? JSON.stringify({ status: input.cancelStatus ?? "cancel-requested" }))}`,
      `    exit ${input.cancelStatus === "cancelled" ? "0" : "2"}`,
      "    ;;",
      "  pause)",
      ...(input.pauseStartedMarkerPath === undefined || input.pauseReleaseMarkerPath === undefined
        ? []
        : [
            `    touch ${shellQuote(input.pauseStartedMarkerPath)}`,
            `    while [ ! -e ${shellQuote(input.pauseReleaseMarkerPath)} ]; do sleep 0.01; done`
          ]),
      `    printf '%s\\n' ${shellQuote(input.pauseOutput ?? JSON.stringify({ status: input.pauseStatus ?? "pause-requested" }))}`,
      `    exit ${input.pauseStatus === "paused" ? "0" : "2"}`,
      "    ;;",
      "  events)",
      '    case " $* " in',
      '      *" --type token "*)',
      '        if [ -n "$SMITHERS_FAKE_REFRESHED_TOKEN_EVENTS" ] && [ -e "$SMITHERS_FAKE_TOKEN_READ_MARKER" ]; then',
      '          cat "$SMITHERS_FAKE_REFRESHED_TOKEN_EVENTS"',
      "        else",
      '          [ -z "$SMITHERS_FAKE_REFRESHED_TOKEN_EVENTS" ] || touch "$SMITHERS_FAKE_TOKEN_READ_MARKER"',
      '          cat "$SMITHERS_FAKE_TOKEN_EVENTS"',
      "        fi",
      "        ;;",
      "      *)",
      '        if [ -n "$SMITHERS_FAKE_FAIL_EVENTS" ]; then',
      '          cat "$SMITHERS_FAKE_EVENTS"',
      "          printf '%s\\n' 'fake events failure' >&2",
      "          exit 1",
      "        fi",
      '        cat "$SMITHERS_FAKE_EVENTS"',
      "        ;;",
      "    esac",
      "    ;;",
      "  output)",
      ...(input.outputStartedMarkerPath === undefined
        ? []
        : [`    touch ${shellQuote(input.outputStartedMarkerPath)}`]),
      ...(input.outputReleaseMarkerPath === undefined
        ? []
        : [`    while [ ! -e ${shellQuote(input.outputReleaseMarkerPath)} ]; do sleep 0.01; done`]),
      '    node "$SMITHERS_FAKE_OUTPUT_HELPER" "$2" "$3" "$SMITHERS_FAKE_INSPECT" "$SMITHERS_FAKE_EVENTS" "$SMITHERS_FAKE_OUTPUT_OVERRIDES"',
      "    ;;",
      "  timeline)",
      '    node "$SMITHERS_FAKE_TIMELINE_RENDERER" "$SMITHERS_FAKE_TIMELINE" "$2"',
      "    ;;",
      "  rewind)",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "  replay)",
      '    source_run_id=""; replay_frame=""; branch_label=""',
      '    previous=""',
      '    for argument in "$@"; do',
      '      [ "$previous" != "--run-id" ] || source_run_id="$argument"',
      '      [ "$previous" != "--frame" ] || replay_frame="$argument"',
      '      [ "$previous" != "--label" ] || branch_label="$argument"',
      '      previous="$argument"',
      "    done",
      '    case "$replay_frame" in ""|*[!0-9]*) printf \'replay requires integer --frame\\n\' >&2; exit 64 ;; esac',
      '    case " $* " in *" --ultrafuzz-prepare-only "*) ;; *) printf \'replay requires prepare-only mode\\n\' >&2; exit 65 ;; esac',
      ...((input.replayTimelineRunId ?? input.replayRunId) === undefined
        ? []
        : [
            `    node "$SMITHERS_FAKE_TIMELINE_RECORDER" "$SMITHERS_FAKE_TIMELINE" "$source_run_id" "$replay_frame" "$branch_label" ${shellQuote((input.replayTimelineRunId ?? input.replayRunId)!)}`
          ]),
      input.replayRunId === undefined
        ? "    printf '%s\\n' '{\"ok\":true}'"
        : `    printf '%s\\n' ${shellQuote(JSON.stringify({ forkedRunId: input.replayRunId }))}`,
      ...(input.replayExitCode === undefined ? [] : [`    exit ${input.replayExitCode}`]),
      "    ;;",
      "  fork)",
      '    source_run_id=""; fork_frame=""; branch_label=""; previous=""',
      '    for argument in "$@"; do',
      '      [ "$previous" != "--run-id" ] || source_run_id="$argument"',
      '      [ "$previous" != "--frame" ] || fork_frame="$argument"',
      '      [ "$previous" != "--label" ] || branch_label="$argument"',
      '      previous="$argument"',
      "    done",
      ...((input.forkTimelineRunId ?? input.forkRunId) === undefined
        ? []
        : [
            `    node "$SMITHERS_FAKE_TIMELINE_RECORDER" "$SMITHERS_FAKE_TIMELINE" "$source_run_id" "$fork_frame" "$branch_label" ${shellQuote((input.forkTimelineRunId ?? input.forkRunId)!)}`
          ]),
      input.forkRunId === undefined
        ? "    printf '%s\\n' '{\"ok\":true}'"
        : `    printf '%s\\n' ${shellQuote(JSON.stringify({ forkedRunId: input.forkRunId }))}`,
      "    ;;",
      "  up)",
      ...(input.lifecycleStartedMarkerPath === undefined || input.lifecycleReleaseMarkerPath === undefined
        ? []
        : [
            '    case " $* " in',
            '      *" --resume "*)',
            `        touch ${shellQuote(input.lifecycleStartedMarkerPath)}`,
            `        while [ ! -e ${shellQuote(input.lifecycleReleaseMarkerPath)} ]; do sleep 0.01; done`,
            "        ;;",
            "    esac"
          ]),
      '    if [ -n "$SMITHERS_FAKE_FAIL_UP" ]; then',
      "      printf '%s\\n' 'fake up failure' >&2",
      "      exit 1",
      "    fi",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "  *)",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  return createSmithersTestEnvironment(smithers, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_FAKE_LOG: path.join(project, "smithers-commands.log"),
    SMITHERS_FAKE_INSPECT: inspectPath,
    SMITHERS_FAKE_EVENTS: eventsPath,
    SMITHERS_FAKE_TOKEN_EVENTS: input.tokenEvents === undefined ? eventsPath : tokenEventsPath,
    SMITHERS_FAKE_FAIL_EVENTS: input.failEvents ? "1" : undefined,
    SMITHERS_FAKE_REFRESHED_TOKEN_EVENTS:
      input.refreshedTokenEvents === undefined ? undefined : refreshedTokenEventsPath,
    SMITHERS_FAKE_TOKEN_READ_MARKER: tokenReadMarkerPath,
    SMITHERS_FAKE_TIMELINE: timelinePath,
    SMITHERS_FAKE_TIMELINE_RECORDER: timelineHelpers.recorder,
    SMITHERS_FAKE_TIMELINE_RENDERER: timelineHelpers.renderer,
    SMITHERS_FAKE_OUTPUT_HELPER: outputHelperPath,
    SMITHERS_FAKE_OUTPUT_OVERRIDES: outputOverridesPath,
    SMITHERS_FAKE_ARTIFACTS_MODULE: testArtifactsModuleUrl,
    SMITHERS_FAKE_ALLOW_MISSING_ARTIFACTS: input.allowMissingVerifierArtifacts ? "1" : undefined,
    SMITHERS_FAKE_PERSISTED_WORKFLOW_PATH_LOG: input.persistedWorkflowPathLog,
    ULTRAFUZZ_PRICING_CATALOG_URL: "off"
  });
}

function defaultWorkflowEvents(inspect: unknown): string {
  const document = inspect as {
    data?: {
      steps?: Array<{
        id?: string;
        nodeId?: string;
        state?: string;
        status?: string;
        attempt?: number;
        iteration?: number;
      }>;
    };
    steps?: Array<{
      id?: string;
      nodeId?: string;
      state?: string;
      status?: string;
      attempt?: number;
      iteration?: number;
    }>;
  };
  const steps = document.data?.steps ?? document.steps ?? [];
  const events: Array<Record<string, unknown>> = [];
  let sequence = 0;
  const startedAt = Date.now() - 2_000;
  for (const step of steps) {
    const nodeId = step.id ?? step.nodeId;
    const state = step.state ?? step.status;
    if (nodeId === undefined || state === undefined) continue;
    const status = eventStatusFromTestWorkflowState(state);
    const payload = { nodeId, attempt: step.attempt ?? 0, iteration: step.iteration ?? 0 };
    if (status !== "pending" && status !== "skipped") {
      events.push({ type: "NodeStarted", seq: sequence++, timestampMs: startedAt + sequence, payload });
    }
    const terminalType =
      status === "succeeded"
        ? "NodeFinished"
        : status === "failed"
          ? "NodeFailed"
          : status === "timed-out"
            ? "TaskHeartbeatTimeout"
            : status === "skipped"
              ? "NodeSkipped"
              : undefined;
    if (terminalType !== undefined) {
      events.push({
        type: terminalType,
        seq: sequence++,
        timestampMs: startedAt + 1_000 + sequence,
        payload: terminalType === "NodeFailed" ? { ...payload, error: { message: "fake task failed" } } : payload
      });
    }
  }
  return events.map((event) => JSON.stringify(event)).join("\n") + (events.length === 0 ? "" : "\n");
}

function eventStatusFromTestWorkflowState(
  state: string
): "pending" | "succeeded" | "failed" | "timed-out" | "skipped" | "other" {
  const normalized = state.toLowerCase();
  if (["finished", "succeeded", "success", "complete", "completed"].includes(normalized)) return "succeeded";
  if (["failed", "failure", "error", "errored"].includes(normalized)) return "failed";
  if (["timed-out", "timed_out", "timeout", "timedout"].includes(normalized)) return "timed-out";
  if (["skipped", "skip"].includes(normalized)) return "skipped";
  if (["pending", "queued", "not-started", "not_started"].includes(normalized)) return "pending";
  return "other";
}

function pricingCatalogDataUrl(catalog: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(catalog))}`;
}

function workflowInspect(input: {
  workflowRunId: string;
  status?: string;
  state?: string;
  computedAt?: string;
  error?: unknown;
  failedChildKeys?: string[];
  includeVerifierSteps?: boolean;
  steps: Array<{ id: string; state: string; attempt?: number; iteration?: number }>;
}): unknown {
  const explicitStepIds = new Set(input.steps.map((step) => step.id));
  const steps =
    input.includeVerifierSteps === false
      ? input.steps
      : input.steps.flatMap((step) => {
          if (!step.id.startsWith("node:") || statusFromTestWorkflowState(step.state) !== "succeeded") {
            return [step];
          }
          const verifierId = `verify:${step.id.slice("node:".length)}`;
          return explicitStepIds.has(verifierId)
            ? [step]
            : [step, { id: verifierId, state: "finished", attempt: step.attempt, iteration: step.iteration }];
        });
  return {
    ok: true,
    data: {
      run: {
        id: input.workflowRunId,
        workflow: input.workflowRunId,
        status: input.status ?? "finished",
        ...(input.error === undefined ? {} : { error: input.error }),
        started: "2026-07-03T00:00:00.000Z",
        finished: input.status === "running" ? undefined : "2026-07-03T00:00:02.000Z"
      },
      runState: {
        runId: input.workflowRunId,
        computedAt: input.computedAt ?? "2026-07-03T00:00:03.000Z",
        state: input.state ?? (input.status === "running" ? "running" : "succeeded")
      },
      ...(input.failedChildKeys === undefined
        ? {}
        : { failedChildren: input.failedChildKeys.length, failedChildKeys: input.failedChildKeys }),
      steps
    }
  };
}

function statusFromTestWorkflowState(state: string): "succeeded" | "other" {
  return ["finished", "succeeded", "success", "complete", "completed"].includes(state.toLowerCase())
    ? "succeeded"
    : "other";
}

function workflowEvents(
  workflowRunId: string,
  events: Array<{
    type: string;
    nodeId?: string;
    attempt?: number;
    error?: unknown;
    sequence?: number;
    timestampMs?: number;
    extra?: Record<string, unknown>;
  }>
): string {
  const base = Date.parse("2026-07-03T00:00:00.000Z");
  return `${events
    .map((event, index) => {
      const sequence = event.sequence ?? index;
      const timestampMs = event.timestampMs ?? base + index * 100;
      const payload: Record<string, unknown> = {
        type: event.type,
        runId: workflowRunId,
        timestampMs
      };
      if (event.nodeId !== undefined) {
        payload.nodeId = event.nodeId;
      }
      if (event.attempt !== undefined) {
        payload.attempt = event.attempt;
      }
      if (event.error !== undefined) {
        payload.error = event.error;
      }
      if (event.extra !== undefined) {
        Object.assign(payload, event.extra);
      }
      return JSON.stringify({
        runId: workflowRunId,
        seq: sequence,
        timestampMs,
        type: event.type,
        payload
      });
    })
    .join("\n")}\n`;
}

function writeRequiredArtifactSet(runRoot: string, nodeId: string, required: string[]): void {
  const artifactDir = path.join(runRoot, "artifacts", nodeId);
  for (const relative of required) {
    const filePath = path.join(artifactDir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const contents = relative.endsWith(".json")
      ? JSON.stringify([
          {
            schema_version: "1.0",
            id: `finding-${nodeId}`,
            title: "Candidate issue",
            status: "candidate",
            severity_guess: "medium",
            confidence: "medium",
            summary: "The generated evidence needs review."
          }
        ])
      : `artifact for ${nodeId}\n`;
    fs.writeFileSync(filePath, contents, "utf8");
  }
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
      - path: setup/project-discovery.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: findings.json
        contract: ultrafuzz/findings@1
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
}

function writeOutOfOrderTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 2
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: actors-flows
    kind: agentic
    prompt: setup/actors-flows.md
    depends_on:
      - project-discovery
    outputs:
      - path: setup/actors-flows.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: setup/project-discovery.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - actors-flows
`,
    "utf8"
  );
}

function writeReferenceTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
groups:
  setup:
    label: Setup
  references:
    label: References
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: reference-properties-example
    kind: reference
    reference: properties.example
    group: references
    depends_on:
      - __start__
    outputs:
      - path: references/example.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: ${RUN_REFERENCE_MANIFEST_FILE}
        contract: ultrafuzz/json-object@1
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    group: setup
    depends_on:
      - reference-properties-example
    outputs:
      - path: setup/project-discovery.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: findings.json
        contract: ultrafuzz/findings@1
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md"),
    `---
id: project-discovery
display_name: Project Discovery
---

Reference:
{{artifact_handoff:reference-properties-example}}

Write output to {{artifact_path}}/setup/project-discovery.md and findings to {{output_findings_path}}.
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "references.yml"),
    `version: 1
references:
  properties.example:
    provider: github
    repo: example/repo
    commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    paths:
      - README.md
      - src/Props.sol
    resolved_at: "2026-06-23T00:00:00Z"
`,
    "utf8"
  );
}

function writeReferenceCache(xdgCacheHome: string): void {
  const cacheDir = path.join(
    xdgCacheHome,
    "ultrafuzz",
    "references",
    "github",
    "example",
    "repo",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  );
  const files: Array<{ path: string; size_bytes: number; sha256: string }> = [];
  for (const [relativePath, contents] of [
    ["README.md", "# Example Reference\n"],
    ["src/Props.sol", "contract Props {}\n"]
  ] as const) {
    const filePath = path.join(cacheDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");
    files.push({
      path: relativePath,
      size_bytes: fs.statSync(filePath).size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
    });
  }
  fs.writeFileSync(
    path.join(cacheDir, CACHE_MANIFEST_FILE),
    `${JSON.stringify(
      {
        schema_version: "1.0",
        provider: "github",
        repo: "example/repo",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        fetched_at: "2026-06-23T00:00:00Z",
        files
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function writeFanoutProject(project: string): void {
  fs.mkdirSync(path.join(project, ".ultrafuzz", "workspaces"), { recursive: true });
  fs.mkdirSync(path.join(project, ".ultrafuzz", "prompts", "setup"), { recursive: true });
  fs.mkdirSync(path.join(project, ".ultrafuzz", "prompts", "strategies"), { recursive: true });
  fs.mkdirSync(path.join(project, ".smithers", "agents"), { recursive: true });
  fs.writeFileSync(path.join(project, ".smithers", "package.json"), '{"private":true}\n', "utf8");
  fs.writeFileSync(
    path.join(project, ".smithers", "agents", "index.ts"),
    "export const CodexAgent = {};\nexport const ClaudeAgent = {};\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, "ultrafuzz.toml"),
    `schema_version = "1.0"

[project]
repo = "."

[run]
output_dir = ".ultrafuzz/runs"

[models]
default = "fast"

[models.fast]
agent = "CodexAgent"
model = "gpt-test-fast"

[models.deep]
agent = "ClaudeAgent"
model = "gpt-test-deep"
`,
    "utf8"
  );
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
    prompt: setup/project-discovery.md
    model_profiles:
      - fast
      - deep
    depends_on:
      - __start__
    outputs:
      - path: setup/project-discovery.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: findings.json
        contract: ultrafuzz/findings@1
  - id: signal-analysis
    prompt: strategies/target-signal.md
    model_profiles:
      - fast
      - deep
    depends_on:
      - project-discovery
    outputs:
      - path: signal-analysis.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: findings.json
        contract: ultrafuzz/findings@1
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - signal-analysis
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md"),
    `---
id: project-discovery
display_name: Project Discovery
---

Strategy: {{strategy}}
Current artifact dir: {{artifact_path}}
Findings: {{output_findings_path}}
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "strategies", "target-signal.md"),
    `---
id: target-signal
display_name: Target Signal
---

Ancestor snapshots:
{{artifact_path:project-discovery}}/setup/project-discovery.md

Current findings: {{output_findings_path}}
`,
    "utf8"
  );
}

test("init preserves existing project-owned files and validate exposes launch posture", async () => {
  const project = tempProject();
  fs.writeFileSync(path.join(project, "ultrafuzz.toml"), "# custom\n", "utf8");

  const init = initProject({ projectRoot: project });
  assert.equal(init.ok, true);
  assert.equal(init.value?.preserved.includes("ultrafuzz.toml"), true);
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "topology.yml")), true);
  assert.equal(fs.existsSync(path.join(project, "topology.yml")), false);
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/index.ts")), true);
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz/prompts/setup/project-discovery.md")), true);
  const smithersPackage = JSON.parse(fs.readFileSync(path.join(project, ".smithers/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };
  assert.equal(smithersPackage.dependencies?.["@moonshot-ai/kimi-code"], KIMI_CODE_VERSION);
  assert.equal(smithersPackage.dependencies?.["smithers-orchestrator"], SMITHERS_ORCHESTRATOR_VERSION);
  assert.equal(smithersPackage.overrides?.effect, SMITHERS_EFFECT_VERSION);
  const codexAgentText = fs.readFileSync(path.join(project, ".smithers/agents/codex.ts"), "utf8");
  assert.doesNotMatch(codexAgentText, /cwd:\s*process\.cwd/);
  assert.doesNotMatch(codexAgentText, /apiKey:\s*process\.env\.OPENAI_API_KEY/);
  assert.match(codexAgentText, /ultrafuzz\.toml/);
  assert.match(codexAgentText, /codexAuthOptions/);
  // The TOML parser is shared, so a fix reaches every backend at once.
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/toml.ts")), true);
  const tomlHelperText = fs.readFileSync(path.join(project, ".smithers/agents/toml.ts"), "utf8");
  assert.match(codexAgentText, /import \{ readStringTable, stringField \} from ".\/toml";/);
  assert.doesNotMatch(codexAgentText, /function readStringTable/);
  // TOML's \UXXXXXXXX has no JSON equivalent, so values are not JSON.parse'd.
  assert.doesNotMatch(tomlHelperText, /JSON\.parse/);
  assert.match(tomlHelperText, /escape !== "u" && escape !== "U"/);
  assert.match(codexAgentText, /const apiKey = requiredEnv/);
  assert.match(codexAgentText, /return { apiKey, env: { CODEX_API_KEY: apiKey } }/);
  assert.match(codexAgentText, /env: { OPENAI_API_KEY: "", CODEX_API_KEY: "" }/);
  assert.match(codexAgentText, /createCodexAgent/);
  assert.match(codexAgentText, /model_reasoning_effort:\s*options\.reasoningEffort/);
  assert.match(codexAgentText, /class CompatibleCodexAgent extends SmithersCodexAgent/);
  assert.match(codexAgentText, /override async buildCommand/);
  assert.match(codexAgentText, /directories\.flatMap\(\(directory\) => \["--add-dir", directory\]\)/);
  assert.match(codexAgentText, /params\.options\?\.resumeSession/);
  assert.match(codexAgentText, /addDir:\s*options\.addDir/);
  assert.match(codexAgentText, /sandbox:\s*"workspace-write"/);
  assert.doesNotMatch(codexAgentText, /model:\s*"gpt-5\.5"/);

  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/claude.ts")), true);
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/deepseek.ts")), true);
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/kimi.ts")), true);
  const agentsIndexText = fs.readFileSync(path.join(project, ".smithers/agents/index.ts"), "utf8");
  assert.match(agentsIndexText, /export \{ createCodexAgent \} from ".\/codex";/);
  assert.match(agentsIndexText, /export \{ createClaudeAgent \} from ".\/claude";/);
  assert.match(agentsIndexText, /export \{ createDeepSeekAgent \} from ".\/deepseek";/);
  assert.match(agentsIndexText, /export \{ createKimiAgent \} from ".\/kimi";/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*ClaudeAgent: createClaudeAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*CodexAgent: createCodexAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*DeepSeekAgent: createDeepSeekAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*KimiAgent: createKimiAgent/);
  // Importing the registry must not construct any agent: doing so reads that
  // agent's auth and fails a project that only uses the other backend.
  assert.doesNotMatch(agentsIndexText, /=\s*create(Codex|Claude|DeepSeek|Kimi)Agent\(\)/);
  assert.doesNotMatch(codexAgentText, /=\s*createCodexAgent\(\)/);
  const claudeAgentText = fs.readFileSync(path.join(project, ".smithers/agents/claude.ts"), "utf8");
  assert.match(claudeAgentText, /ClaudeCodeAgent/);
  assert.match(claudeAgentText, /createClaudeAgent/);
  assert.match(claudeAgentText, /permissionMode:\s*"bypassPermissions"/);
  assert.match(claudeAgentText, /extraArgs:\s*\["--effort",\s*options\.reasoningEffort\]/);
  assert.match(claudeAgentText, /claudeAuthOptions/);
  assert.match(claudeAgentText, /ANTHROPIC_API_KEY/);
  assert.match(claudeAgentText, /addDir:\s*options\.addDir/);
  assert.doesNotMatch(claudeAgentText, /apiKey:\s*process\.env\.ANTHROPIC_API_KEY/);
  // The model comes from the resolved model profile, never hard-coded in the template.
  assert.doesNotMatch(claudeAgentText, /model:\s*"claude-[\w.-]+"/);
  // skipGitRepoCheck is a CodexAgent option and has no ClaudeCodeAgent equivalent.
  assert.doesNotMatch(claudeAgentText, /skipGitRepoCheck/);
  assert.doesNotMatch(claudeAgentText, /=\s*createClaudeAgent\(\)/);
  assert.match(claudeAgentText, /import \{ readStringTable, stringField \} from ".\/toml";/);
  assert.doesNotMatch(claudeAgentText, /function readStringTable/);
  assert.doesNotMatch(claudeAgentText, /JSON\.parse/);
  const deepSeekAgentText = fs.readFileSync(path.join(project, ".smithers/agents/deepseek.ts"), "utf8");
  assert.match(deepSeekAgentText, /DeepSeekClaudeCodeAgent/);
  assert.match(deepSeekAgentText, /createDeepSeekAgent/);
  assert.match(deepSeekAgentText, /https:\/\/api\.deepseek\.com\/anthropic/);
  assert.match(deepSeekAgentText, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(deepSeekAgentText, /DEEPSEEK_API_KEY/);
  assert.match(deepSeekAgentText, /cacheReadTokens/);
  assert.match(deepSeekAgentText, /reasoningTokens: 0/);
  assert.doesNotMatch(deepSeekAgentText, /=\s*createDeepSeekAgent\(\)/);
  const kimiAgentText = fs.readFileSync(path.join(project, ".smithers/agents/kimi.ts"), "utf8");
  assert.match(kimiAgentText, /KimiAgent/);
  assert.match(kimiAgentText, /createKimiAgent/);
  assert.match(kimiAgentText, /KIMI_API_KEY/);
  assert.match(kimiAgentText, /MOONSHOT_API_KEY/);
  assert.match(kimiAgentText, /KIMI_CODE_HOME/);
  assert.match(kimiAgentText, /KIMI_SHARE_DIR/);
  assert.match(kimiAgentText, /--add-dir/);
  assert.match(kimiAgentText, /--prompt/);
  assert.match(kimiAgentText, /--output-format/);
  assert.match(kimiAgentText, /configDir/);
  assert.doesNotMatch(kimiAgentText, /=\s*createKimiAgent\(\)/);
  assert.doesNotMatch(kimiAgentText, /--yolo/);
  assert.doesNotMatch(kimiAgentText, /--auto/);
  assert.doesNotMatch(kimiAgentText, /--print/);
  assert.doesNotMatch(kimiAgentText, /--work-dir/);
  assert.doesNotMatch(kimiAgentText, /--thinking/);
  assert.doesNotMatch(kimiAgentText, /--no-thinking/);
  assert.doesNotMatch(kimiAgentText, /final-message-only/);
  const environmentAgentText = fs.readFileSync(path.join(project, ".smithers/agents/environment.ts"), "utf8");
  // These paths are controller capabilities into a sealed execution snapshot.
  // Smithers' CLI agents inherit the controller environment by default, so
  // every generated adapter must explicitly blank them before spawning an
  // untrusted agent process.
  for (const agentSource of [codexAgentText, claudeAgentText, deepSeekAgentText, kimiAgentText]) {
    assert.match(agentSource, /import \{ workflowControlChildEnvironment \} from "\.\/environment";/u);
    assert.match(agentSource, /env: .*workflowControlChildEnvironment\(\)/u);
  }
  for (const name of [
    "SMITHERS_BIN",
    "SMITHERS_CLI_SRC_DIR",
    "ULTRAFUZZ_ARTIFACTS_MODULE",
    "ULTRAFUZZ_CONFIG_PATH",
    "ULTRAFUZZ_MODAL_MODULE",
    "ULTRAFUZZ_RUNTIME_MODULE",
    "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH"
  ]) {
    assert.match(environmentAgentText, new RegExp(`"${name}"`, "u"));
  }

  const validate = await validateProject({ projectRoot: project, env: {} });
  assert.equal(validate.ok, true, JSON.stringify(validate.diagnostics));
  assert.equal(validate.value?.policy_posture.trust.status, "pass");
  assert.equal(validate.value?.policy_posture.agents.status, "pass");
  assert.equal(validate.value?.policy_posture.paths.status, "pass");
  assert.equal(validate.value?.resolved_config?.default_agent, "CodexAgent");
  assert.equal(validate.value?.resolved_config?.default_model, "gpt-5.5");
  assert.equal(validate.value?.resolved_config?.default_reasoning, "xhigh");
});

test("init upgrades only byte-exact released agent scaffolds", () => {
  const releasedCodex = [
    'import { CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";',
    "",
    "export const CodexAgent = new SmithersCodexAgent({",
    '  model: "gpt-5.5",',
    "  skipGitRepoCheck: true,",
    "  apiKey: process.env.OPENAI_API_KEY,",
    "});",
    ""
  ].join("\n");
  const preDeepSeekRegistry = [
    'import { createClaudeAgent } from "./claude";',
    'import { createCodexAgent } from "./codex";',
    'import { createKimiAgent } from "./kimi";',
    "",
    'export { createClaudeAgent } from "./claude";',
    'export { createCodexAgent } from "./codex";',
    'export { createKimiAgent } from "./kimi";',
    "",
    "// Agents are constructed per task from the selected model profile, never at",
    "// import time: an agent's auth is only read when that agent is actually used,",
    "// so a project running one backend does not need the other's credentials.",
    "export const agentFactories = {",
    "  ClaudeAgent: createClaudeAgent,",
    "  CodexAgent: createCodexAgent,",
    "  KimiAgent: createKimiAgent",
    "};",
    ""
  ].join("\n");
  assert.equal(
    crypto.createHash("sha256").update(releasedCodex).digest("hex"),
    "26dae14e43c09dbe7901aa731cd552b282d502d86cea8cc6726e4a8579cd3236"
  );
  assert.equal(
    crypto.createHash("sha256").update(preDeepSeekRegistry).digest("hex"),
    "58a1c796bef8466ec77c04a01fcb60bb1e91b55d437f0c69499f054db6305535"
  );

  const reference = tempProject();
  assert.equal(initProject({ projectRoot: reference, force: true }).ok, true);
  const currentCodex = fs.readFileSync(path.join(reference, ".smithers/agents/codex.ts"), "utf8");
  const currentRegistry = fs.readFileSync(path.join(reference, ".smithers/agents/index.ts"), "utf8");

  const releasedProject = tempProject();
  fs.mkdirSync(path.join(releasedProject, ".smithers/agents"), { recursive: true });
  fs.writeFileSync(path.join(releasedProject, ".smithers/agents/codex.ts"), releasedCodex, "utf8");
  fs.writeFileSync(path.join(releasedProject, ".smithers/agents/index.ts"), preDeepSeekRegistry, "utf8");

  const upgraded = initProject({ projectRoot: releasedProject });

  assert.equal(upgraded.ok, true, JSON.stringify(upgraded.diagnostics));
  assert.equal(fs.readFileSync(path.join(releasedProject, ".smithers/agents/codex.ts"), "utf8"), currentCodex);
  assert.equal(fs.readFileSync(path.join(releasedProject, ".smithers/agents/index.ts"), "utf8"), currentRegistry);
  assert.equal(
    upgraded.diagnostics.filter((diagnostic) => diagnostic.code === "INIT_AGENT_REGISTRY_STALE").length,
    0,
    JSON.stringify(upgraded.diagnostics)
  );

  const customizedProject = tempProject();
  fs.mkdirSync(path.join(customizedProject, ".smithers/agents"), { recursive: true });
  const oneByteCodex = releasedCodex.replace('model: "gpt-5.5"', 'model: "gpt-5.4"');
  const oneByteRegistry = preDeepSeekRegistry.replace("KimiAgent: createKimiAgent", "KimiAgent: createKimiAgenx");
  const customDeepSeek = [
    "// project-owned DeepSeek adapter",
    'const configPath = path.join(process.cwd(), "ultrafuzz.toml");',
    ""
  ].join("\n");
  assert.equal(Buffer.byteLength(oneByteCodex), Buffer.byteLength(releasedCodex));
  assert.equal(Buffer.byteLength(oneByteRegistry), Buffer.byteLength(preDeepSeekRegistry));
  fs.writeFileSync(path.join(customizedProject, ".smithers/agents/codex.ts"), oneByteCodex, "utf8");
  fs.writeFileSync(path.join(customizedProject, ".smithers/agents/index.ts"), oneByteRegistry, "utf8");
  fs.writeFileSync(path.join(customizedProject, ".smithers/agents/deepseek.ts"), customDeepSeek, "utf8");

  const preserved = initProject({ projectRoot: customizedProject });

  assert.equal(preserved.ok, true, JSON.stringify(preserved.diagnostics));
  assert.equal(fs.readFileSync(path.join(customizedProject, ".smithers/agents/codex.ts"), "utf8"), oneByteCodex);
  assert.equal(fs.readFileSync(path.join(customizedProject, ".smithers/agents/index.ts"), "utf8"), oneByteRegistry);
  assert.equal(fs.readFileSync(path.join(customizedProject, ".smithers/agents/deepseek.ts"), "utf8"), customDeepSeek);
  const staleConfigPath = preserved.diagnostics.filter(
    (diagnostic) => diagnostic.code === "INIT_AGENT_CONFIG_PATH_STALE"
  );
  assert.deepEqual(
    staleConfigPath.map((diagnostic) => diagnostic.path),
    [".smithers/agents/deepseek.ts"]
  );
  assert.match(staleConfigPath[0]?.message ?? "", /ultrafuzz init --force/u);
  assert.match(staleConfigPath[0]?.message ?? "", /process\.env\.ULTRAFUZZ_CONFIG_PATH/u);

  const forced = initProject({ projectRoot: customizedProject, force: true });
  assert.equal(forced.ok, true, JSON.stringify(forced.diagnostics));
  assert.equal(fs.readFileSync(path.join(customizedProject, ".smithers/agents/codex.ts"), "utf8"), currentCodex);
  assert.equal(fs.readFileSync(path.join(customizedProject, ".smithers/agents/index.ts"), "utf8"), currentRegistry);
});

test("generated agent child environments contain no execution-snapshot paths", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  const source = fs.readFileSync(path.join(project, ".smithers", "agents", "environment.ts"), "utf8");
  const modulePath = path.join(project, "agent-environment-test.mjs");
  fs.writeFileSync(
    modulePath,
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true
      }
    }).outputText,
    "utf8"
  );
  const { workflowControlChildEnvironment } = (await import(pathToFileURL(modulePath).href)) as {
    workflowControlChildEnvironment: (source: Record<string, string | undefined>) => Record<string, string>;
  };
  const snapshotRoot = path.join(project, ".ultrafuzz", "runs", "sealed", "smithers", "execution-snapshots", "abc");
  const descriptorRoot = `/proc/${process.pid}/fd/42`;
  const controller = {
    SMITHERS_BIN: path.join(descriptorRoot, "dependencies", "runner.js"),
    SMITHERS_CLI_SRC_DIR: path.join(descriptorRoot, "dependencies", "cli", "src"),
    ULTRAFUZZ_ARTIFACTS_MODULE: pathToFileURL(
      path.join(descriptorRoot, "modules", "@ultrafuzz", "artifacts", "dist", "index.js")
    ).href,
    ULTRAFUZZ_CONFIG_PATH: path.join(descriptorRoot, "controls", "ultrafuzz.toml"),
    ULTRAFUZZ_RUNTIME_MODULE: pathToFileURL(
      path.join(descriptorRoot, "modules", "@ultrafuzz", "runtime", "dist", "index.js")
    ).href,
    ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: path.join(snapshotRoot, ".smithers", "workflows", "run.tsx"),
    UNKNOWN_LEXICAL_ALIAS: path.join(snapshotRoot, "controls", "private.json"),
    UNKNOWN_DESCRIPTOR_ALIAS: path.join(descriptorRoot, "controls", "private.json"),
    SAFE_VALUE: path.join(project, "safe")
  };
  const merged = { ...controller, ...workflowControlChildEnvironment(controller) };
  assert.equal(merged.SAFE_VALUE, controller.SAFE_VALUE);
  assert.deepEqual(
    Object.entries(merged).filter(([, value]) => value.includes(snapshotRoot) || value.includes(descriptorRoot)),
    []
  );
});

test("agent postflight preserves provider identity and classifies canonical findings failures", async () => {
  const usage = Object.freeze({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
  const frozenResult = Object.freeze({
    response: Object.freeze({ modelId: "deepseek-v4-flash" }),
    usage
  });
  let postflightFailure: unknown;
  try {
    await runAgentWithPostflight(
      async () => frozenResult,
      async (_result, postflight) =>
        postflight("canonical-findings-normalization-postflight", () => {
          throw new Error("canonical findings failed");
        })
    );
  } catch (error) {
    postflightFailure = error;
  }
  assert.ok(postflightFailure instanceof AgentPostflightError);
  assert.equal(postflightFailure.code, "canonical-findings-normalization-postflight");
  assert.equal(postflightFailure.result?.response.modelId, "deepseek-v4-flash");
  assert.equal(postflightFailure.usage, usage);
  assert.equal(agentPostflightFailureCode(postflightFailure), "canonical-findings-normalization-postflight");
  assert.equal(
    agentPostflightFailureCode(
      new Error(
        "AgentPostflightError: ultrafuzz-agent-postflight:canonical-findings-normalization-postflight: redacted"
      )
    ),
    "canonical-findings-normalization-postflight"
  );
  const workflowTemplate = fs.readFileSync(
    path.join(process.cwd(), "src/templates/smithers/workflows/workflow.tsx"),
    "utf8"
  );
  assert.match(workflowTemplate, /code:[\s\S]*\| "canonical-findings-normalization-postflight"[\s\S]*operation:/u);

  const providerFailure = Object.freeze(
    Object.assign(new Error("provider failed"), {
      result: Object.freeze({ response: Object.freeze({ modelId: "deepseek-v4-flash" }) })
    })
  );
  let observedProviderFailure: unknown;
  try {
    await runAgentWithPostflight(
      async () => {
        throw providerFailure;
      },
      async () => {
        assert.fail("postflight must not run after provider failure");
      }
    );
  } catch (error) {
    observedProviderFailure = error;
  }
  assert.equal(observedProviderFailure, providerFailure);
  assert.equal(
    (observedProviderFailure as { result?: { response?: { modelId?: string } } }).result?.response?.modelId,
    "deepseek-v4-flash"
  );
});

test(
  "generated Codex adapter repeats artifact directory flags and preserves resume argv",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project });
    assert.equal(init.ok, true);
    const { CompatibleCodexAgent } = await loadGeneratedCodexAgent(project);
    const agent = new CompatibleCodexAgent({ addDir: ["/tmp/artifacts", "/tmp/dependency artifacts"] });

    const fresh = await agent.buildCommand({ prompt: "test", cwd: project, options: {} });
    const firstAddDir = fresh.args.indexOf("--add-dir");
    assert.deepEqual(fresh.args.slice(firstAddDir, firstAddDir + 4), [
      "--add-dir",
      "/tmp/artifacts",
      "--add-dir",
      "/tmp/dependency artifacts"
    ]);
    assert.equal(fresh.args.at(-1), "-");
    await fresh.cleanup?.();

    const resumed = await agent.buildCommand({
      prompt: "test",
      cwd: project,
      options: { resumeSession: "session-123" }
    });
    assert.equal(resumed.args.includes("--add-dir"), false);
    await resumed.cleanup?.();
  }
);

test(
  "generated DeepSeek adapter uses the official endpoint and preserves independent usage components",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { DeepSeekClaudeCodeAgent } = await loadGeneratedDeepSeekAgent(project);
    const agent = new DeepSeekClaudeCodeAgent({
      model: "deepseek-v4-pro",
      extraArgs: ["--effort", "max"],
      permissionMode: "bypassPermissions",
      ultrafuzzApiKey: "deepseek-test-key",
      configDir: path.join(project, ".ultrafuzz", "deepseek-claude")
    });

    const command = await agent.buildCommand({ prompt: "Contract only", cwd: project, options: {} });
    assert.equal(command.command, "claude");
    assert.equal(command.args.includes("deepseek-v4-pro"), true);
    assert.deepEqual(command.args.slice(command.args.indexOf("--effort"), command.args.indexOf("--effort") + 2), [
      "--effort",
      "max"
    ]);
    assert.equal(command.env?.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(command.env?.ANTHROPIC_AUTH_TOKEN, "deepseek-test-key");
    assert.equal(command.env?.ANTHROPIC_API_KEY, "");
    assert.equal(command.env?.DEEPSEEK_API_KEY, "");
    assert.equal(command.env?.CLAUDE_CONFIG_DIR, path.join(project, ".ultrafuzz", "deepseek-claude"));
    assert.equal(command.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, path.join(project, ".ultrafuzz", "deepseek-claude"));
    for (const name of [
      "ANTHROPIC_CONFIG_DIR",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_IDENTITY_TOKEN",
      "ANTHROPIC_IDENTITY_TOKEN_FILE",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_PROFILE",
      "ANTHROPIC_UNIX_SOCKET",
      "CCR_OAUTH_TOKEN_FILE",
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
      "CLAUDE_CODE_HOST_CREDS_FILE",
      "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
      "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
      "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_GATEWAY",
      "CLAUDE_CODE_USE_MANTLE",
      "CLAUDE_CODE_USE_VERTEX"
    ]) {
      assert.equal(command.env?.[name], "", `${name} must not leak into DeepSeek Claude Code invocations`);
    }

    const interpreter = agent.createOutputInterpreter();
    interpreter.onStdoutLine?.(
      JSON.stringify({
        type: "assistant",
        message: { model: "deepseek-v4-pro", content: [{ type: "text", text: "done" }] }
      })
    );
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      modelUsage: deepSeekModelUsage("deepseek-v4-pro", 121, 31, 401, 2),
      // This top-level aggregate excludes nested agents and must not win.
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 999,
        reasoning_tokens: 20
      }
    });
    const lineEvents = (interpreter.onStdoutLine?.(resultLine) ?? []) as Array<{
      type?: string;
      usage?: Record<string, number>;
    }>;
    const exitEvents = (interpreter.onExit?.({ exitCode: 0 }) ?? []) as Array<{
      type?: string;
      usage?: Record<string, number>;
    }>;
    const events = [...lineEvents, ...exitEvents];
    const completed = events.find((event) => event.type === "completed");
    // DeepSeek bills cache creation as an ordinary cache-miss input token and
    // publishes no cache-write rate, so the 2 reported cache-creation tokens are
    // folded into the uncached input component they are actually billed as. The
    // token total is preserved exactly, and the cache-write component stays 0 so
    // no token is ever priced against a nonexistent rate.
    assert.deepEqual(completed?.usage, {
      input_tokens: 123,
      output_tokens: 31,
      cache_read_input_tokens: 401,
      cache_creation_input_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 555
    });
  }
);

test("generated DeepSeek adapter clears a custom API-key source variable", { skip: !runningUnderBun }, async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  const configPath = path.join(project, "ultrafuzz.toml");
  const defaultConfig = fs.readFileSync(configPath, "utf8");
  const customConfig = defaultConfig.replace('api_key_env = "DEEPSEEK_API_KEY"', 'api_key_env = "MY_DEEPSEEK_SECRET"');
  assert.notEqual(customConfig, defaultConfig, "generated config must contain the default DeepSeek key source");
  fs.writeFileSync(configPath, customConfig, "utf8");

  const previousConfigPath = process.env.ULTRAFUZZ_CONFIG_PATH;
  const previousCustomSecret = process.env.MY_DEEPSEEK_SECRET;
  const previousCanonicalSecret = process.env.DEEPSEEK_API_KEY;
  process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
  process.env.MY_DEEPSEEK_SECRET = "custom-deepseek-test-key";
  process.env.DEEPSEEK_API_KEY = "unrelated-canonical-host-key";
  try {
    const { createDeepSeekAgent } = await loadGeneratedDeepSeekAgent(project);
    const agent = createDeepSeekAgent({ model: "deepseek-v4-flash" });
    process.env.MY_DEEPSEEK_SECRET = "must-not-be-reread";

    const command = await agent.buildCommand({ prompt: "Contract only", cwd: project, options: {} });
    assert.equal(command.env?.ANTHROPIC_AUTH_TOKEN, "custom-deepseek-test-key");
    assert.equal(command.env?.MY_DEEPSEEK_SECRET, "");
    assert.equal(command.env?.DEEPSEEK_API_KEY, "");
    assert.deepEqual(
      Object.entries(command.env ?? {})
        .filter(([, value]) => value === "custom-deepseek-test-key")
        .map(([name]) => name),
      ["ANTHROPIC_AUTH_TOKEN"]
    );
  } finally {
    if (previousConfigPath === undefined) delete process.env.ULTRAFUZZ_CONFIG_PATH;
    else process.env.ULTRAFUZZ_CONFIG_PATH = previousConfigPath;
    if (previousCustomSecret === undefined) delete process.env.MY_DEEPSEEK_SECRET;
    else process.env.MY_DEEPSEEK_SECRET = previousCustomSecret;
    if (previousCanonicalSecret === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousCanonicalSecret;
  }
});

test(
  "generated DeepSeek adapter corrects Smithers result and failed-attempt telemetry",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { DeepSeekClaudeCodeAgent } = await loadGeneratedDeepSeekAgent(project);
    const providerUsage = {
      prompt_cache_miss_tokens: 101,
      prompt_cache_hit_tokens: 400,
      output_tokens: 23,
      reasoning_tokens: 17
    };
    const normalizedUsage = {
      inputTokens: 101,
      inputTokenDetails: { noCacheTokens: 101, cacheReadTokens: 400, cacheWriteTokens: 0 },
      outputTokens: 23,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: 0 },
      totalTokens: 524
    };

    const successful = new DeepSeekClaudeCodeAgent({ model: "deepseek-v4-flash", ultrafuzzApiKey: "test-key" });
    successful.buildCommand = async () => ({
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(${JSON.stringify(
          `${JSON.stringify({
            type: "assistant",
            message: { model: "deepseek-v4-flash", content: [{ type: "text", text: "done" }] }
          })}\n${JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
            model: "configured-echo-must-be-ignored",
            session_id: "deepseek-session",
            modelUsage: deepSeekModelUsage("deepseek-v4-flash", 101, 23, 400),
            usage: providerUsage
          })}\n`
        )})`
      ],
      outputFormat: "stream-json"
    });
    const result = await successful.generate({ prompt: "Telemetry", rootDir: project });
    assert.deepEqual(result.usage, normalizedUsage);
    assert.equal(result.response?.modelId, "deepseek-v4-flash");

    const streamed = await successful.stream({ prompt: "Stream telemetry", rootDir: project });
    assert.deepEqual(await streamed.usage, normalizedUsage);
    assert.deepEqual(await streamed.totalUsage, normalizedUsage);
    assert.equal((await streamed.response)?.modelId, "deepseek-v4-flash");

    const failed = new DeepSeekClaudeCodeAgent({ model: "deepseek-v4-flash", ultrafuzzApiKey: "test-key" });
    failed.buildCommand = async () => ({
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(${JSON.stringify(
          `${JSON.stringify({
            type: "assistant",
            message: { model: "deepseek-v4-flash", content: [{ type: "text", text: "partial" }] }
          })}\n${JSON.stringify({
            type: "result",
            subtype: "error",
            is_error: true,
            error: "provider failed",
            model: "configured-echo-must-be-ignored",
            modelUsage: deepSeekModelUsage("deepseek-v4-flash", 101, 23, 400),
            usage: providerUsage
          })}\n`
        )}); process.exit(17)`
      ],
      outputFormat: "stream-json"
    });
    let failure: unknown;
    try {
      await failed.generate({ prompt: "Failed telemetry", rootDir: project });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.deepEqual((failure as Error & { usage?: unknown }).usage, normalizedUsage);
    assert.equal(
      (failure as Error & { result?: { response?: { modelId?: string } } }).result?.response?.modelId,
      "deepseek-v4-flash"
    );
  }
);

test(
  "generated DeepSeek adapter preserves raw provider identity and fails closed on absent or contradictory evidence",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { DeepSeekClaudeCodeAgent } = await loadGeneratedDeepSeekAgent(project);
    const result = (
      model?: unknown,
      response?: unknown,
      usageModel = "deepseek-v4-flash"
    ): Record<string, unknown> => ({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      ...(model === undefined ? {} : { model }),
      ...(response === undefined ? {} : { response }),
      modelUsage: deepSeekModelUsage(usageModel, 1, 1),
      usage: { input_tokens: 1, output_tokens: 1, prompt_cache_hit_tokens: 0 }
    });
    const cases: Array<{ name: string; lines: unknown[]; expected: string }> = [
      {
        name: "exact raw alias",
        lines: [
          { type: "system", subtype: "init", session_id: "exact", model: "deepseek-v4-flash" },
          {
            type: "assistant",
            message: { model: "deepseek-v4-flash", content: [{ type: "text", text: "done" }] }
          },
          result("deepseek-v4-flash")
        ],
        expected: "deepseek-v4-flash"
      },
      {
        name: "system-only configuration echo is not provider evidence",
        lines: [{ type: "system", subtype: "init", session_id: "missing", model: "deepseek-v4-flash" }, result()],
        expected: "ultrafuzz-provider-identity-missing"
      },
      {
        name: "result-only configuration echoes are not provider evidence",
        lines: [result("deepseek-v4-flash", { modelId: "deepseek-v4-flash" })],
        expected: "ultrafuzz-provider-identity-missing"
      },
      {
        name: "conflicting raw identity",
        lines: [
          { type: "system", subtype: "init", session_id: "mixed", model: "deepseek-v4-flash" },
          {
            type: "assistant",
            message: { model: "deepseek-v4-flash", content: [{ type: "text", text: "first" }] }
          },
          {
            type: "assistant",
            message: { model: "deepseek-v4-flash-20260801", content: [{ type: "text", text: "done" }] }
          },
          result("deepseek-v4-flash")
        ],
        expected: "ultrafuzz-provider-identity-mixed"
      },
      {
        name: "a later assistant without a raw model invalidates earlier exact evidence",
        lines: [
          {
            type: "assistant",
            message: { model: "deepseek-v4-flash", content: [{ type: "text", text: "first" }] }
          },
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "done" }] }
          },
          result("deepseek-v4-flash")
        ],
        expected: "ultrafuzz-provider-identity-invalid"
      },
      {
        name: "valid substituted build remains verbatim",
        lines: [
          {
            type: "assistant",
            message: { model: "deepseek-v4-flash-20260801", content: [{ type: "text", text: "done" }] }
          },
          result("deepseek-v4-flash", undefined, "deepseek-v4-flash-20260801")
        ],
        expected: "deepseek-v4-flash-20260801"
      },
      {
        name: "invalid raw identity",
        lines: [
          {
            type: "assistant",
            message: { model: "deep seek/v4", content: [{ type: "text", text: "done" }] }
          },
          result("deepseek-v4-flash")
        ],
        expected: "ultrafuzz-provider-identity-invalid"
      },
      {
        name: "oversized raw identity",
        lines: [
          {
            type: "assistant",
            message: { model: "d".repeat(513), content: [{ type: "text", text: "done" }] }
          },
          result("deepseek-v4-flash")
        ],
        expected: "ultrafuzz-provider-identity-invalid"
      }
    ];

    for (const testCase of cases) {
      const agent = new DeepSeekClaudeCodeAgent({ model: "deepseek-v4-flash", ultrafuzzApiKey: "test-key" });
      const output = `${testCase.lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
      agent.buildCommand = async () => ({
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
        outputFormat: "stream-json"
      });
      const generated = await agent.generate({ prompt: testCase.name, rootDir: project });
      assert.equal(generated.response?.modelId, testCase.expected, testCase.name);
    }
  }
);

test(
  "generated DeepSeek adapter decorates frozen success, stream, and error records with raw evidence",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { DeepSeekClaudeCodeAgent } = await loadGeneratedDeepSeekAgent(project);
    const parentPrototype = Object.getPrototypeOf(DeepSeekClaudeCodeAgent.prototype) as {
      generate: (...args: unknown[]) => Promise<unknown>;
      stream: (...args: unknown[]) => Promise<unknown>;
    };
    const originalGenerate = parentPrototype.generate;
    const originalStream = parentPrototype.stream;
    const providerUsage = {
      prompt_cache_miss_tokens: 13,
      prompt_cache_hit_tokens: 21,
      output_tokens: 8
    };
    const normalizedUsage = {
      inputTokens: 13,
      inputTokenDetails: { noCacheTokens: 13, cacheReadTokens: 21, cacheWriteTokens: 0 },
      outputTokens: 8,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: 0 },
      totalTokens: 42
    };
    const recordEvidence = (agent: {
      createOutputInterpreter(): {
        onStdoutLine?: (line: string) => unknown;
        onExit?: (result: unknown) => unknown;
      };
    }): void => {
      const interpreter = agent.createOutputInterpreter();
      interpreter.onStdoutLine?.(
        JSON.stringify({
          type: "assistant",
          message: { model: "deepseek-v4-flash", content: [{ type: "text", text: "done" }] }
        })
      );
      interpreter.onStdoutLine?.(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          model: "configured-fallback",
          modelUsage: deepSeekModelUsage("deepseek-v4-flash", 13, 8, 21),
          usage: providerUsage
        })
      );
      interpreter.onExit?.({ exitCode: 0 });
    };

    try {
      const frozenSuccess = Object.freeze({
        output: Object.freeze({ summary: "preserved output" }),
        response: Object.freeze({ modelId: "configured-fallback", providerMetadata: "preserved" }),
        text: "done",
        totalUsage: Object.freeze({ inputTokens: 999 }),
        usage: Object.freeze({ inputTokens: 999 })
      });
      parentPrototype.generate = async function (this: {
        createOutputInterpreter(): { onStdoutLine?: (line: string) => unknown; onExit?: (result: unknown) => unknown };
      }) {
        recordEvidence(this);
        return frozenSuccess;
      };
      const successful = new DeepSeekClaudeCodeAgent({ model: "configured-fallback", ultrafuzzApiKey: "test-key" });
      const generated = (await successful.generate({ prompt: "frozen success", rootDir: project })) as {
        output?: unknown;
        response?: { modelId?: string; providerMetadata?: string };
        totalUsage?: unknown;
        usage?: unknown;
      };
      assert.notEqual(generated, frozenSuccess);
      assert.equal(generated.output, frozenSuccess.output);
      assert.equal(generated.response?.modelId, "deepseek-v4-flash");
      assert.equal(generated.response?.providerMetadata, "preserved");
      assert.deepEqual(generated.usage, normalizedUsage);
      assert.deepEqual(generated.totalUsage, normalizedUsage);

      const frozenStream = Object.freeze({
        response: Promise.resolve(Object.freeze({ modelId: "configured-fallback", providerMetadata: "preserved" })),
        totalUsage: Promise.resolve(Object.freeze({ inputTokens: 999 })),
        usage: Promise.resolve(Object.freeze({ inputTokens: 999 }))
      });
      parentPrototype.stream = async function (this: {
        createOutputInterpreter(): { onStdoutLine?: (line: string) => unknown; onExit?: (result: unknown) => unknown };
      }) {
        recordEvidence(this);
        return frozenStream;
      };
      const streaming = new DeepSeekClaudeCodeAgent({ model: "configured-fallback", ultrafuzzApiKey: "test-key" });
      const streamed = (await streaming.stream({ prompt: "frozen stream", rootDir: project })) as {
        response?: Promise<{ modelId?: string; providerMetadata?: string }>;
        totalUsage?: Promise<unknown>;
        usage?: Promise<unknown>;
      };
      assert.notEqual(streamed, frozenStream);
      assert.equal((await streamed.response)?.modelId, "deepseek-v4-flash");
      assert.equal((await streamed.response)?.providerMetadata, "preserved");
      assert.deepEqual(await streamed.usage, normalizedUsage);
      assert.deepEqual(await streamed.totalUsage, normalizedUsage);

      const frozenFailure = Object.freeze(
        Object.assign(new Error("frozen provider failure"), {
          code: "AGENT_CLI_ERROR",
          details: Object.freeze({ failureRetryable: true }),
          result: Object.freeze({
            response: Object.freeze({ modelId: "configured-fallback", providerMetadata: "preserved" })
          }),
          totalUsage: Object.freeze({ inputTokens: 999 }),
          usage: Object.freeze({ inputTokens: 999 })
        })
      );
      parentPrototype.generate = async function (this: {
        createOutputInterpreter(): { onStdoutLine?: (line: string) => unknown; onExit?: (result: unknown) => unknown };
      }) {
        recordEvidence(this);
        throw frozenFailure;
      };
      const failing = new DeepSeekClaudeCodeAgent({ model: "configured-fallback", ultrafuzzApiKey: "test-key" });
      let observedFailure: unknown;
      try {
        await failing.generate({ prompt: "frozen failure", rootDir: project });
      } catch (error) {
        observedFailure = error;
      }
      assert.ok(observedFailure instanceof Error);
      assert.notEqual(observedFailure, frozenFailure);
      assert.equal(observedFailure.message, "frozen provider failure");
      assert.equal((observedFailure as { code?: string }).code, "AGENT_CLI_ERROR");
      assert.deepEqual((observedFailure as { details?: unknown }).details, { failureRetryable: true });
      assert.deepEqual((observedFailure as { usage?: unknown }).usage, normalizedUsage);
      assert.deepEqual((observedFailure as { totalUsage?: unknown }).totalUsage, normalizedUsage);
      assert.equal(
        (observedFailure as { result?: { response?: { modelId?: string } } }).result?.response?.modelId,
        "deepseek-v4-flash"
      );
      assert.equal(
        (observedFailure as { result?: { response?: { providerMetadata?: string } } }).result?.response
          ?.providerMetadata,
        "preserved"
      );
    } finally {
      parentPrototype.generate = originalGenerate;
      parentPrototype.stream = originalStream;
    }
  }
);

test(
  "generated DeepSeek adapter preserves immutable evidence for opaque results and failures",
  {
    skip: !runningUnderBun
  },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { DeepSeekClaudeCodeAgent } = await loadGeneratedDeepSeekAgent(project);
    type EvidenceAgent = {
      createOutputInterpreter(): {
        onStdoutLine?: (line: string) => unknown;
        onExit?: (result: unknown) => unknown;
      };
    };
    const parentPrototype = Object.getPrototypeOf(DeepSeekClaudeCodeAgent.prototype) as {
      generate: (...args: unknown[]) => Promise<unknown>;
      stream: (...args: unknown[]) => Promise<unknown>;
    };
    const originalGenerate = parentPrototype.generate;
    const originalStream = parentPrototype.stream;
    const normalizedUsage = {
      inputTokens: 2,
      inputTokenDetails: { noCacheTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokens: 3,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: 0 },
      totalTokens: 5
    };
    const recordEvidence = (agent: EvidenceAgent): void => {
      const interpreter = agent.createOutputInterpreter();
      interpreter.onStdoutLine?.(
        JSON.stringify({ type: "assistant", message: { model: "deepseek-v4-flash", content: [] } })
      );
      interpreter.onStdoutLine?.(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          modelUsage: deepSeekModelUsage("deepseek-v4-flash", 2, 3),
          usage: { input_tokens: 2, output_tokens: 3 }
        })
      );
      interpreter.onExit?.({ exitCode: 0 });
    };
    const capturedFailure = async (promise: Promise<unknown>): Promise<unknown> => {
      try {
        await promise;
      } catch (error) {
        return error;
      }
      assert.fail("expected opaque provider value to fail closed");
    };
    const assertImmutableEvidence = (value: unknown, cause: unknown, label: string): void => {
      assert.ok(value instanceof Error, label);
      const error = value as Error & {
        usage?: typeof normalizedUsage;
        totalUsage?: typeof normalizedUsage;
        result?: { response?: { modelId?: string } };
      };
      assert.equal(error.name, "DeepSeekProviderEvidenceError", label);
      assert.equal(error.cause, cause, label);
      assert.deepEqual(error.usage, normalizedUsage, label);
      assert.equal(error.totalUsage, error.usage, label);
      assert.equal(error.result?.response?.modelId, "deepseek-v4-flash", label);
      for (const property of ["cause", "usage", "totalUsage", "result"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(error, property);
        assert.equal(descriptor?.configurable, false, `${label}:${property}:configurable`);
        assert.equal(descriptor?.writable, false, `${label}:${property}:writable`);
      }
      assert.equal(Object.isFrozen(error.usage), true, `${label}:usage`);
      assert.equal(Object.isFrozen(error.usage?.inputTokenDetails), true, `${label}:input details`);
      assert.equal(Object.isFrozen(error.usage?.outputTokenDetails), true, `${label}:output details`);
      assert.equal(Object.isFrozen(error.result), true, `${label}:result`);
      assert.equal(Object.isFrozen(error.result?.response), true, `${label}:response`);
    };

    try {
      const returned = Proxy.revocable({ response: { modelId: "configured-fallback" } }, {});
      const returnedProxy = returned.proxy;
      parentPrototype.generate = function (this: EvidenceAgent) {
        recordEvidence(this);
        const result = Promise.resolve(returnedProxy);
        returned.revoke();
        return result;
      };
      const returnedAgent = new DeepSeekClaudeCodeAgent({
        model: "configured-fallback",
        ultrafuzzApiKey: "test-key"
      });
      assertImmutableEvidence(
        await capturedFailure(returnedAgent.generate({ prompt: "opaque result", rootDir: project })),
        returnedProxy,
        "returned revoked proxy"
      );

      const streamed = Proxy.revocable({ response: Promise.resolve({ modelId: "configured-fallback" }) }, {});
      const streamedProxy = streamed.proxy;
      parentPrototype.stream = function (this: EvidenceAgent) {
        recordEvidence(this);
        const result = Promise.resolve(streamedProxy);
        streamed.revoke();
        return result;
      };
      const streamedAgent = new DeepSeekClaudeCodeAgent({
        model: "configured-fallback",
        ultrafuzzApiKey: "test-key"
      });
      assertImmutableEvidence(
        await capturedFailure(streamedAgent.stream({ prompt: "opaque stream", rootDir: project })),
        streamedProxy,
        "returned revoked stream proxy"
      );

      const thrown = Proxy.revocable(new Error("opaque provider failure"), {});
      const thrownProxy = thrown.proxy;
      thrown.revoke();
      parentPrototype.generate = async function (this: EvidenceAgent) {
        recordEvidence(this);
        throw thrownProxy;
      };
      const failingAgent = new DeepSeekClaudeCodeAgent({
        model: "configured-fallback",
        ultrafuzzApiKey: "test-key"
      });
      assertImmutableEvidence(
        await capturedFailure(failingAgent.generate({ prompt: "opaque failure", rootDir: project })),
        thrownProxy,
        "thrown revoked proxy"
      );

      const primitiveFailure = "primitive provider failure";
      parentPrototype.generate = async function (this: EvidenceAgent) {
        recordEvidence(this);
        throw primitiveFailure;
      };
      const primitiveAgent = new DeepSeekClaudeCodeAgent({
        model: "configured-fallback",
        ultrafuzzApiKey: "test-key"
      });
      assertImmutableEvidence(
        await capturedFailure(primitiveAgent.generate({ prompt: "primitive failure", rootDir: project })),
        primitiveFailure,
        "thrown primitive"
      );
    } finally {
      parentPrototype.generate = originalGenerate;
      parentPrototype.stream = originalStream;
    }
  }
);

test("generated DeepSeek adapter isolates overlapping invocation evidence", { skip: !runningUnderBun }, async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  const { DeepSeekClaudeCodeAgent } = await loadGeneratedDeepSeekAgent(project);
  type EvidenceAgent = {
    createOutputInterpreter(): {
      onStdoutLine?: (line: string) => unknown;
      onExit?: (result: unknown) => unknown;
    };
  };
  const parentPrototype = Object.getPrototypeOf(DeepSeekClaudeCodeAgent.prototype) as {
    generate: (...args: unknown[]) => Promise<unknown>;
    stream: (...args: unknown[]) => Promise<unknown>;
  };
  const originalGenerate = parentPrototype.generate;
  const originalStream = parentPrototype.stream;
  const recordEvidence = (agent: EvidenceAgent, model: string, inputTokens: number, outputTokens: number): void => {
    const interpreter = agent.createOutputInterpreter();
    interpreter.onStdoutLine?.(
      JSON.stringify({ type: "assistant", message: { model, content: [{ type: "text", text: "done" }] } })
    );
    interpreter.onStdoutLine?.(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        modelUsage: deepSeekModelUsage(model, inputTokens, outputTokens),
        usage: { input_tokens: inputTokens, output_tokens: outputTokens }
      })
    );
    interpreter.onExit?.({ exitCode: 0 });
  };
  const normalizedUsage = (inputTokens: number, outputTokens: number) => ({
    inputTokens,
    inputTokenDetails: { noCacheTokens: inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: 0 },
    totalTokens: inputTokens + outputTokens
  });
  const resultRecord = () => ({
    response: { modelId: "configured-fallback" },
    usage: { inputTokens: 999 },
    totalUsage: { inputTokens: 999 }
  });

  try {
    let releaseFirstGenerate = (): void => assert.fail("first generate release was not installed");
    let markFirstGenerateReady = (): void => assert.fail("first generate readiness was not installed");
    const firstGenerateGate = new Promise<void>((resolve) => {
      releaseFirstGenerate = resolve;
    });
    const firstGenerateReady = new Promise<void>((resolve) => {
      markFirstGenerateReady = resolve;
    });
    parentPrototype.generate = async function (this: EvidenceAgent, ...args: unknown[]) {
      const prompt = (args[0] as { prompt?: string } | undefined)?.prompt;
      const first = prompt === "generate-a";
      recordEvidence(this, first ? "deepseek-v4-flash-a" : "deepseek-v4-flash-b", first ? 2 : 20, first ? 3 : 30);
      if (first) {
        markFirstGenerateReady();
        await firstGenerateGate;
      }
      return resultRecord();
    };
    const generateAgent = new DeepSeekClaudeCodeAgent({
      model: "configured-fallback",
      ultrafuzzApiKey: "test-key"
    });
    const firstGenerate = generateAgent.generate({ prompt: "generate-a", rootDir: project });
    await firstGenerateReady;
    const secondGenerate = await generateAgent.generate({ prompt: "generate-b", rootDir: project });
    releaseFirstGenerate();
    const completedFirstGenerate = await firstGenerate;
    assert.equal(completedFirstGenerate.response?.modelId, "deepseek-v4-flash-a");
    assert.deepEqual(completedFirstGenerate.usage, normalizedUsage(2, 3));
    assert.equal(secondGenerate.response?.modelId, "deepseek-v4-flash-b");
    assert.deepEqual(secondGenerate.usage, normalizedUsage(20, 30));

    let releaseGenerate = (): void => assert.fail("generate release was not installed");
    let markGenerateReady = (): void => assert.fail("generate readiness was not installed");
    const generateGate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    const generateReady = new Promise<void>((resolve) => {
      markGenerateReady = resolve;
    });
    parentPrototype.generate = async function (this: EvidenceAgent) {
      recordEvidence(this, "deepseek-v4-flash-generate", 5, 8);
      markGenerateReady();
      await generateGate;
      return resultRecord();
    };
    parentPrototype.stream = async function (this: EvidenceAgent) {
      recordEvidence(this, "deepseek-v4-flash-stream", 50, 80);
      const result = resultRecord();
      return {
        response: Promise.resolve(result.response),
        usage: Promise.resolve(result.usage),
        totalUsage: Promise.resolve(result.totalUsage)
      };
    };
    const mixedAgent = new DeepSeekClaudeCodeAgent({
      model: "configured-fallback",
      ultrafuzzApiKey: "test-key"
    });
    const generating = mixedAgent.generate({ prompt: "generate", rootDir: project });
    await generateReady;
    const streaming = await mixedAgent.stream({ prompt: "stream", rootDir: project });
    releaseGenerate();
    const generated = await generating;
    assert.equal(generated.response?.modelId, "deepseek-v4-flash-generate");
    assert.deepEqual(generated.usage, normalizedUsage(5, 8));
    assert.equal((await streaming.response)?.modelId, "deepseek-v4-flash-stream");
    assert.deepEqual(await streaming.usage, normalizedUsage(50, 80));
    assert.deepEqual(await streaming.totalUsage, normalizedUsage(50, 80));
  } finally {
    parentPrototype.generate = originalGenerate;
    parentPrototype.stream = originalStream;
  }
});

test(
  "generated DeepSeek adapter keeps malformed whole-tree usage fail-closed",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { DeepSeekClaudeCodeAgent } = await loadGeneratedDeepSeekAgent(project);
    const parentPrototype = Object.getPrototypeOf(DeepSeekClaudeCodeAgent.prototype) as {
      generate: (...args: unknown[]) => Promise<unknown>;
    };
    const originalGenerate = parentPrototype.generate;
    const fabricatedUsage = Object.freeze({ inputTokens: 77, outputTokens: 88, totalTokens: 165 });
    const providerModel = "deepseek-v4-flash";
    const completeUsage = {
      inputTokens: 5,
      outputTokens: 7,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 0
    };
    const result = (modelUsage?: unknown): Record<string, unknown> => ({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      ...(modelUsage === undefined ? {} : { modelUsage }),
      // A valid top-level aggregate must never fill gaps in modelUsage.
      usage: { input_tokens: 500, output_tokens: 700, cache_read_input_tokens: 200 }
    });
    const cases: Array<{
      name: string;
      lines: Array<Record<string, unknown>>;
      expectedModelId?: string;
    }> = [
      { name: "absent model usage", lines: [result()] },
      { name: "empty model usage", lines: [result({})] },
      { name: "array model usage", lines: [result([])] },
      {
        name: "extra model entry",
        lines: [
          result({
            ...deepSeekModelUsage(providerModel, 5, 7, 2),
            ...deepSeekModelUsage("deepseek-v4-flash-shadow", 5, 7, 2)
          })
        ]
      },
      {
        name: "unsafe model entry",
        lines: [result({ "deep seek/v4": completeUsage })]
      },
      {
        name: "mismatched model entry",
        lines: [result(deepSeekModelUsage("deepseek-v4-flash-20260801", 5, 7, 2))]
      },
      {
        name: "malformed model entry",
        lines: [result({ [providerModel]: null })]
      },
      {
        name: "missing input",
        lines: [result({ [providerModel]: { ...completeUsage, inputTokens: undefined } })]
      },
      {
        name: "missing output",
        lines: [result({ [providerModel]: { ...completeUsage, outputTokens: undefined } })]
      },
      {
        name: "missing cache read",
        lines: [result({ [providerModel]: { ...completeUsage, cacheReadInputTokens: undefined } })]
      },
      {
        name: "missing cache creation",
        lines: [result({ [providerModel]: { ...completeUsage, cacheCreationInputTokens: undefined } })]
      },
      {
        name: "malformed token count",
        lines: [result({ [providerModel]: { ...completeUsage, inputTokens: "5" } })]
      },
      {
        name: "negative token count",
        lines: [result({ [providerModel]: { ...completeUsage, cacheReadInputTokens: -1 } })]
      },
      {
        name: "non-integral token count",
        lines: [result({ [providerModel]: { ...completeUsage, outputTokens: 7.5 } })]
      },
      {
        name: "partial then complete",
        lines: [
          result({ [providerModel]: { ...completeUsage, inputTokens: undefined } }),
          result({ [providerModel]: completeUsage })
        ]
      },
      {
        name: "complete then partial",
        lines: [result({ [providerModel]: completeUsage }), result()]
      },
      {
        name: "duplicate complete results",
        lines: [result({ [providerModel]: completeUsage }), result({ [providerModel]: completeUsage })]
      },
      {
        name: "provider identity changes after result",
        lines: [
          result({ [providerModel]: completeUsage }),
          { type: "assistant", message: { model: "deepseek-v4-flash-shadow", content: [] } }
        ],
        expectedModelId: "ultrafuzz-provider-identity-mixed"
      }
    ];
    try {
      for (const testCase of cases) {
        const frozenResult = Object.freeze({
          response: Object.freeze({ modelId: "configured-fallback" }),
          totalUsage: fabricatedUsage,
          usage: fabricatedUsage
        });
        let completedEvents: Array<{ type?: string; usage?: unknown }> = [];
        parentPrototype.generate = async function (this: {
          createOutputInterpreter(): {
            onStdoutLine?: (line: string) => unknown;
            onExit?: (result: unknown) => unknown;
          };
        }) {
          const interpreter = this.createOutputInterpreter();
          completedEvents = [
            ...completedEvents,
            ...((interpreter.onStdoutLine?.(
              JSON.stringify({ type: "assistant", message: { model: providerModel, content: [] } })
            ) ?? []) as Array<{ type?: string; usage?: unknown }>),
            ...testCase.lines.flatMap(
              (line) =>
                (interpreter.onStdoutLine?.(JSON.stringify(line)) ?? []) as Array<{ type?: string; usage?: unknown }>
            ),
            ...((interpreter.onExit?.({ exitCode: 0 }) ?? []) as Array<{ type?: string; usage?: unknown }>)
          ];
          return frozenResult;
        };
        const agent = new DeepSeekClaudeCodeAgent({ model: "configured-fallback", ultrafuzzApiKey: "test-key" });
        const generated = (await agent.generate({ prompt: testCase.name, rootDir: project })) as {
          response?: { modelId?: string };
          totalUsage?: unknown;
          usage?: unknown;
        };
        assert.equal(generated.response?.modelId, testCase.expectedModelId ?? providerModel, testCase.name);
        assert.equal(generated.usage, undefined, testCase.name);
        assert.equal(generated.totalUsage, undefined, testCase.name);
        const terminal = completedEvents.filter((event) => event.type === "completed");
        assert.equal(terminal.length, 1, testCase.name);
        assert.equal(terminal[0]?.usage, undefined, testCase.name);
      }
    } finally {
      parentPrototype.generate = originalGenerate;
    }
  }
);

test(
  "generated DeepSeek postflight failure preserves real engine usage through sync and ledger replay",
  { skip: !runningUnderBun, timeout: 30_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    writeSmallTopology(project);

    const productRunId = "generated-deepseek-postflight-engine";
    const workflowRunId = `ultrafuzz-${productRunId}`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId,
        status: "failed",
        state: "failed",
        steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
      }),
      events: ""
    });
    const run = await startRun({
      projectRoot: project,
      runId: productRunId,
      agent: "DeepSeekAgent",
      model: "deepseek-v4-flash",
      env
    });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

    const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-postflight-engine-"));
    const smithersEntry = fs.realpathSync(
      path.join(process.cwd(), "node_modules", "smithers-orchestrator", "src", "index.js")
    );
    const smithersRequire = createRequire(smithersEntry);
    const smithersModule = await import(pathToFileURL(smithersEntry).href);
    const jsxModule = await import(pathToFileURL(path.join(path.dirname(smithersEntry), "jsx-runtime.js")).href);
    const effectModule = await import(pathToFileURL(smithersRequire.resolve("effect")).href);
    const zodModule = await import(pathToFileURL(smithersRequire.resolve("zod")).href);
    const api = smithersModule.createSmithers(
      { result: zodModule.z.object({ summary: zodModule.z.string() }) },
      { dbPath: path.join(engineRoot, "smithers.db") }
    );
    const usage = {
      inputTokens: 11,
      inputTokenDetails: { noCacheTokens: 11, cacheReadTokens: 3, cacheWriteTokens: 0 },
      outputTokens: 7,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: 0 },
      totalTokens: 21
    };
    let providerCalls = 0;
    const baseAgent = {
      id: "DeepSeekAgent",
      model: "deepseek-v4-flash",
      supportsNativeStructuredOutput: true,
      generate: async (_args?: unknown) => {
        providerCalls += 1;
        return {
          usage,
          response: { modelId: "deepseek-v4-flash" },
          output: { summary: "provider completed" },
          text: "provider completed"
        };
      }
    };
    const wrappedAgent = {
      id: "DeepSeekAgent:ultrafuzz-artifacts",
      model: baseAgent.model,
      supportsNativeStructuredOutput: true,
      generate: (args: unknown) =>
        runAgentWithPostflight(
          () => baseAgent.generate(args),
          async (_result, postflight) =>
            postflight("artifact-validation-postflight", () => {
              throw new Error("private postflight detail");
            })
        )
    };
    const workflow = api.smithers(() =>
      jsxModule.jsx(api.Workflow, {
        name: "postflight-engine-proof",
        children: jsxModule.jsx(api.Task, {
          id: "node:project-discovery",
          agent: wrappedAgent,
          output: api.outputs.result,
          retries: 2,
          children: "local fake"
        })
      })
    );
    const engineEvents: Array<Record<string, unknown>> = [];
    smithersModule.reopenSingleRunnerRuntime();
    try {
      await effectModule.Effect.runPromise(
        smithersModule.runWorkflow(workflow, {
          input: {},
          runId: workflowRunId,
          rootDir: engineRoot,
          onProgress: (event: Record<string, unknown>) => engineEvents.push(event)
        })
      );
    } finally {
      await smithersModule.closeSingleRunnerRuntime();
    }

    const relevantEvents = engineEvents.filter((event) =>
      ["NodeStarted", "TokenUsageReported", "NodeFailed", "RunFailed"].includes(String(event.type))
    );
    assert.deepEqual(
      relevantEvents.map((event) => event.type),
      ["NodeStarted", "TokenUsageReported", "NodeFailed", "RunFailed"]
    );
    assert.equal(providerCalls, 1);
    assert.equal(
      engineEvents.some((event) => event.type === "NodeRetrying"),
      false
    );
    const usageEvent = relevantEvents[1];
    assert.equal(usageEvent?.model, "deepseek-v4-flash");
    assert.equal(usageEvent?.inputTokens, 11);
    assert.equal(usageEvent?.outputTokens, 7);
    assert.equal(usageEvent?.cacheReadTokens, 3);
    assert.equal(usageEvent?.cacheWriteTokens, 0);
    assert.equal(usageEvent?.reasoningTokens, 0);
    assert.equal(usageEvent?.totalTokens, undefined, "Smithers token events do not carry aggregate totals");
    const nodeFailure = relevantEvents[2]?.error as
      | {
          code?: unknown;
          message?: unknown;
          usage?: unknown;
          result?: { response?: { modelId?: unknown } };
        }
      | undefined;
    assert.equal(nodeFailure?.code, "artifact-validation-postflight");
    assert.match(String(nodeFailure?.message), /^ultrafuzz-agent-postflight:artifact-validation-postflight:/u);
    assert.deepEqual(nodeFailure?.usage, {
      ...usage,
      outputTokenDetails: { reasoningTokens: 0 }
    });
    assert.equal(nodeFailure?.result?.response?.modelId, "deepseek-v4-flash");

    const serializedEvents = `${relevantEvents
      .map((event, index) =>
        JSON.stringify({
          runId: workflowRunId,
          seq: index,
          timestampMs: event.timestampMs,
          type: event.type,
          payload: event
        })
      )
      .join("\n")}\n`;
    fs.writeFileSync(env.SMITHERS_FAKE_EVENTS!, serializedEvents, "utf8");
    fs.writeFileSync(env.SMITHERS_FAKE_TOKEN_EVENTS!, serializedEvents, "utf8");

    const sync = await syncRun({ projectRoot: project, runId: productRunId, env });
    assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
    const usageLedger = fs
      .readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            usage?: { reasoning_tokens?: number; total_tokens?: number };
            usage_complete?: boolean;
            usage_incomplete_reasons?: unknown[];
          }
      );
    assert.equal(usageLedger.length, 1);
    assert.equal(usageLedger[0]?.usage?.reasoning_tokens, 0);
    assert.equal(usageLedger[0]?.usage?.total_tokens, 21);
    assert.equal(usageLedger[0]?.usage_complete, true);
    assert.deepEqual(usageLedger[0]?.usage_incomplete_reasons, []);
    const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
      nodes?: Record<string, { provenance?: { failure?: { category?: string; code?: string } } }>;
    };
    assert.equal(state.nodes?.["project-discovery"]?.provenance?.failure?.category, "artifact-contract");
    assert.equal(state.nodes?.["project-discovery"]?.provenance?.failure?.code, "artifact-validation-postflight");
    const attempts = fs
      .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { failure_category?: string });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.failure_category, "artifact-validation");
    const metadataPath = path.join(run.value!.run_root, "run.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      accounting?: {
        current?: {
          uncached_input_tokens?: number;
          output_tokens?: number;
          cache_read_tokens?: number;
          cache_write_tokens?: number;
          reasoning_tokens?: number;
          total_tokens?: number;
          event_count?: number;
          models?: string[];
        };
        model_identity?: {
          schema_version?: string;
          status?: string;
          invocation_count?: number;
          configured_models?: string[];
          provider_reported_models?: string[];
          invocations?: Array<{
            invocation_id?: string;
            configured_model?: string;
            provider_reported_model?: string;
          }>;
        };
      };
      [key: string]: unknown;
    };
    assert.deepEqual(metadata.accounting?.current, {
      ...metadata.accounting?.current,
      uncached_input_tokens: 11,
      output_tokens: 7,
      cache_read_tokens: 3,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 21,
      event_count: 1,
      models: ["deepseek-v4-flash"]
    });
    assert.equal(metadata.accounting?.model_identity?.status, "complete");
    assert.equal(metadata.accounting?.model_identity?.invocation_count, 1);
    assert.deepEqual(metadata.accounting?.model_identity?.configured_models, ["deepseek-v4-flash"]);
    assert.deepEqual(metadata.accounting?.model_identity?.provider_reported_models, ["deepseek-v4-flash"]);
    const durableModelIdentity = structuredClone(metadata.accounting?.model_identity);

    delete metadata.accounting;
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    fs.writeFileSync(env.SMITHERS_FAKE_TOKEN_EVENTS!, "", "utf8");
    const replayed = await syncRun({ projectRoot: project, runId: productRunId, env });
    assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
    const replayedMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      accounting?: {
        source?: string;
        current?: { total_tokens?: number; event_count?: number; models?: string[] };
        model_identity?: unknown;
      };
    };
    assert.equal(replayedMetadata.accounting?.source, "usage-ledger");
    assert.equal(replayedMetadata.accounting?.current?.total_tokens, 21);
    assert.equal(replayedMetadata.accounting?.current?.event_count, 1);
    assert.deepEqual(replayedMetadata.accounting?.current?.models, ["deepseek-v4-flash"]);
    assert.deepEqual(replayedMetadata.accounting?.model_identity, durableModelIdentity);
  }
);

test(
  "generated Kimi adapter narrows the pinned Smithers command to Kimi Code 0.29.1",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = path.join(project, "kimi-source");
    fs.mkdirSync(path.join(sourceConfig, "credentials"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceConfig, "config.toml"),
      `default_model = "kimi-k3"

[thinking]
enabled = false
effort = "high"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
oauth = { storage = "file", key = "oauth/kimi-code" }

[models.kimi-k3]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
support_efforts = [ "low", "high", "max" ]
default_effort = "high"
`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(sourceConfig, "credentials", "kimi-code.json"),
      JSON.stringify({
        access_token: "fresh-token",
        refresh_token: "refresh-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        expires_in: 3600
      }),
      "utf8"
    );
    fs.writeFileSync(path.join(sourceConfig, "device_id"), "test-device\n", "utf8");
    fs.writeFileSync(path.join(sourceConfig, "session_index.jsonl"), '{"unrelated":true}\n', "utf8");
    fs.mkdirSync(path.join(sourceConfig, "sessions"));
    fs.writeFileSync(path.join(sourceConfig, "sessions", "unrelated.json"), "{}\n", "utf8");

    const options = {
      model: "kimi-k3",
      configDir: sourceConfig,
      ultrafuzzAuthMode: "subscription",
      ultrafuzzReasoningEffort: "max",
      extraArgs: ["--add-dir", "/workspace/extra"]
    };

    const smithersModule = (await import(
      pathToFileURL(
        fs.realpathSync(path.join(process.cwd(), "node_modules", "smithers-orchestrator", "src", "index.js"))
      ).href
    )) as {
      KimiAgent: new (options: Record<string, unknown>) => {
        buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
          args: string[];
          cleanup?: () => Promise<void>;
        }>;
      };
    };
    const pinnedBase = new smithersModule.KimiAgent(options);
    const pinnedCommand = await pinnedBase.buildCommand({
      prompt: "Pinned Smithers contract",
      cwd: "/workspace/target",
      options: {}
    });
    assert.equal(SMITHERS_ORCHESTRATOR_VERSION, "0.32.0");
    assert.ok(pinnedCommand.args.includes("--final-message-only"));
    assert.ok(pinnedCommand.args.includes("--print"));
    assert.ok(pinnedCommand.args.includes("--work-dir"));
    assert.ok(pinnedCommand.args.includes("--thinking"));
    assert.ok(pinnedCommand.args.includes("--session"));
    await pinnedCommand.cleanup?.();

    const agents = [new KimiCode029Agent(options), new KimiCode029Agent(options)];
    const commands = await Promise.all(
      agents.map((agent) => agent.buildCommand({ prompt: "Return the result", cwd: "/workspace/target", options: {} }))
    );

    const isolatedDirs = commands.map((command) => command.env?.KIMI_SHARE_DIR);
    assert.ok(isolatedDirs.every((directory): directory is string => typeof directory === "string"));
    assert.notEqual(isolatedDirs[0], isolatedDirs[1]);

    for (const command of commands) {
      assert.deepEqual(command.args, [
        "--output-format",
        "text",
        "--model",
        "kimi-k3",
        "--add-dir",
        "/workspace/extra",
        "--prompt",
        "Return the result"
      ]);
      assert.equal(command.args.includes("--session"), false);
      assert.equal(command.env?.KIMI_CODE_HOME, command.env?.KIMI_SHARE_DIR);
      const isolated = command.env?.KIMI_SHARE_DIR;
      assert.ok(isolated);
      const isolatedConfigText = fs.readFileSync(path.join(isolated, "config.toml"), "utf8");
      assert.match(isolatedConfigText, /default_effort = "max"/u);
      assert.match(isolatedConfigText, /\[thinking\]\nenabled = true\neffort = "max"/u);
      assert.doesNotMatch(isolatedConfigText, /enabled = false/u);
      assert.doesNotMatch(isolatedConfigText, /effort = "high"/u);
      assert.equal(fs.readFileSync(path.join(isolated, "device_id"), "utf8"), "test-device\n");
      const isolatedCredentials = JSON.parse(
        fs.readFileSync(path.join(isolated, "credentials", "kimi-code.json"), "utf8")
      ) as { access_token?: string };
      assert.equal(isolatedCredentials.access_token, "fresh-token");
      assert.equal(fs.existsSync(path.join(isolated, "session_index.jsonl")), false);
      assert.equal(fs.existsSync(path.join(isolated, "sessions")), false);
      assert.ok(
        command.benignStderrPatterns.some((pattern) => pattern.test("To resume this session: kimi -r session-1234"))
      );
    }

    const previousSharedAuthHome = process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME;
    const sharedAuthHome = path.join(project, "shared-kimi-auth");
    const sourceCredentialPath = path.join(sourceConfig, "credentials", "kimi-code.json");
    fs.mkdirSync(path.join(sharedAuthHome, "credentials"), { recursive: true });
    fs.writeFileSync(
      path.join(sharedAuthHome, "credentials", "kimi-code.json"),
      `${JSON.stringify({
        access_token: "stale-shared-access",
        expires_at: Math.floor(Date.now() / 1000) + 7200,
        expires_in: 7200
      })}\n`,
      "utf8"
    );
    process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME = sharedAuthHome;
    let sharedAuthCommand: Awaited<ReturnType<InstanceType<typeof KimiCode029Agent>["buildCommand"]>> | undefined;
    try {
      sharedAuthCommand = await new KimiCode029Agent(options).buildCommand({
        prompt: "Shared auth",
        cwd: "/workspace/target",
        options: {}
      });
      assert.ok(sharedAuthCommand.env?.KIMI_CODE_HOME);
      const isolatedCredentials = path.join(sharedAuthCommand.env.KIMI_CODE_HOME, "credentials");
      assert.equal(fs.lstatSync(isolatedCredentials).isSymbolicLink(), true);
      assert.equal(fs.realpathSync(isolatedCredentials), path.join(sharedAuthHome, "credentials"));
      assert.equal(fs.existsSync(path.join(sharedAuthHome, "oauth", "kimi-code")), true);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(sharedAuthHome, "credentials", "kimi-code.json"), "utf8")).refresh_token,
        "refresh-token"
      );
    } finally {
      if (previousSharedAuthHome === undefined) delete process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME;
      else process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME = previousSharedAuthHome;
      await sharedAuthCommand?.cleanup?.();
    }

    fs.writeFileSync(
      path.join(sharedAuthHome, "credentials", "kimi-code.json"),
      `${JSON.stringify({
        access_token: "rotated-shared-access",
        refresh_token: "rotated-shared-refresh",
        expires_at: Math.floor(Date.now() / 1000) + 60,
        expires_in: 900
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      sourceCredentialPath,
      `${JSON.stringify({
        access_token: "ancestor-source-access",
        refresh_token: "refresh-token",
        expires_at: Math.floor(Date.now() / 1000) + 7200,
        expires_in: 900
      })}\n`,
      "utf8"
    );
    process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME = sharedAuthHome;
    let rotatedSharedAuthCommand:
      Awaited<ReturnType<InstanceType<typeof KimiCode029Agent>["buildCommand"]>> | undefined;
    try {
      rotatedSharedAuthCommand = await new KimiCode029Agent(options).buildCommand({
        prompt: "Shared rotated auth",
        cwd: "/workspace/target",
        options: {}
      });
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(sharedAuthHome, "credentials", "kimi-code.json"), "utf8")).refresh_token,
        "rotated-shared-refresh"
      );
    } finally {
      if (previousSharedAuthHome === undefined) delete process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME;
      else process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME = previousSharedAuthHome;
      await rotatedSharedAuthCommand?.cleanup?.();
    }

    fs.writeFileSync(
      sourceCredentialPath,
      `${JSON.stringify({
        access_token: "expired-source-access",
        refresh_token: "source-refresh-must-not-rotate",
        expires_at: 1,
        expires_in: 1
      })}\n`,
      "utf8"
    );
    const previousOauthHost = process.env.KIMI_OAUTH_HOST;
    process.env.KIMI_OAUTH_HOST = "https://127.0.0.1:9";
    let expiredSourceCommand: Awaited<ReturnType<InstanceType<typeof KimiCode029Agent>["buildCommand"]>> | undefined;
    try {
      expiredSourceCommand = await new KimiCode029Agent(options).buildCommand({
        prompt: "Expired source should not refresh during build",
        cwd: "/workspace/target",
        options: {}
      });
      assert.equal(expiredSourceCommand.args.includes("--session"), false);
      const sourceToken = JSON.parse(fs.readFileSync(sourceCredentialPath, "utf8")) as { refresh_token?: string };
      assert.equal(sourceToken.refresh_token, "source-refresh-must-not-rotate");
    } finally {
      if (previousOauthHost === undefined) delete process.env.KIMI_OAUTH_HOST;
      else process.env.KIMI_OAUTH_HOST = previousOauthHost;
      await expiredSourceCommand?.cleanup?.();
    }

    const resumeSession = "00000000-0000-0000-0000-000000000105";
    const resumed = await new KimiCode029Agent(options).buildCommand({
      prompt: "Resume",
      cwd: "/workspace/target",
      options: { resumeSession }
    });
    // Assert the full resume argv so the contract also locks the ABSENCE of a
    // conflicting --continue: a real resume must carry only the specific
    // --session, never continue-latest alongside it.
    assert.deepEqual(resumed.args, [
      "--output-format",
      "text",
      "--session",
      resumeSession,
      "--model",
      "kimi-k3",
      "--add-dir",
      "/workspace/extra",
      "--prompt",
      "Resume"
    ]);
    assert.ok(!resumed.args.includes("--continue"));

    const recoverable = new KimiCode029Agent(options);
    const recoveryCommand = await recoverable.buildCommand({
      prompt: "Recover",
      cwd: "/workspace/target",
      options: {}
    });
    assert.ok(recoveryCommand.env?.KIMI_CODE_HOME);
    const cliSession = "00000000-0000-0000-0000-000000000106";
    const recoveryBucket = "wd_target_000000000106";
    const recoverySessionDir = path.join(recoveryCommand.env.KIMI_CODE_HOME, "sessions", recoveryBucket, cliSession);
    fs.mkdirSync(path.join(recoverySessionDir, "agents", "main"), { recursive: true });
    fs.writeFileSync(
      path.join(recoverySessionDir, "state.json"),
      `${JSON.stringify({
        workDir: "/workspace/target",
        agents: {
          main: {
            homedir: path.join(recoverySessionDir, "agents", "main"),
            type: "agent",
            parentAgentId: null
          }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(recoveryCommand.env.KIMI_CODE_HOME, "session_index.jsonl"),
      `${JSON.stringify({
        sessionId: cliSession,
        sessionDir: recoverySessionDir,
        workDir: "/workspace/target"
      })}\n`,
      "utf8"
    );
    const interpreter = recoverable.createOutputInterpreter();
    const completed = interpreter.onExit?.({
      command: "kimi",
      args: recoveryCommand.args,
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false
    }) as Array<{ type?: string; resume?: string }>;
    assert.equal(completed.find((event) => event.type === "completed")?.resume, cliSession);
    await recoveryCommand.cleanup?.();

    const persistedSessionDir = path.join(sourceConfig, "sessions", recoveryBucket, cliSession);
    assert.equal(fs.existsSync(path.join(persistedSessionDir, "state.json")), true);
    const persistedState = JSON.parse(fs.readFileSync(path.join(persistedSessionDir, "state.json"), "utf8")) as {
      agents?: { main?: { homedir?: string } };
    };
    assert.equal(persistedState.agents?.main?.homedir, path.join(persistedSessionDir, "agents", "main"));

    const resumedCaptured = await new KimiCode029Agent(options).buildCommand({
      prompt: "Resume captured",
      cwd: "/workspace/target",
      options: { resumeSession: cliSession }
    });
    assert.ok(resumedCaptured.env?.KIMI_CODE_HOME);
    assert.deepEqual(resumedCaptured.args, [
      "--output-format",
      "text",
      "--session",
      cliSession,
      "--model",
      "kimi-k3",
      "--add-dir",
      "/workspace/extra",
      "--prompt",
      "Resume captured"
    ]);
    const resumedSessionDir = path.join(resumedCaptured.env.KIMI_CODE_HOME, "sessions", recoveryBucket, cliSession);
    assert.equal(fs.existsSync(path.join(resumedSessionDir, "state.json")), true);
    const resumedState = JSON.parse(fs.readFileSync(path.join(resumedSessionDir, "state.json"), "utf8")) as {
      agents?: { main?: { homedir?: string } };
    };
    assert.equal(resumedState.agents?.main?.homedir, path.join(resumedSessionDir, "agents", "main"));

    const abandoned = new KimiCode029Agent(options);
    const abandonedCommand = await abandoned.buildCommand({
      prompt: "Abandoned before cleanup",
      cwd: "/workspace/target",
      options: {}
    });
    assert.ok(abandonedCommand.env?.KIMI_CODE_HOME);
    const abandonedHome = abandonedCommand.env.KIMI_CODE_HOME;
    assert.match(path.relative(sourceConfig, abandonedHome), /^\.ultrafuzz-invocations\//u);
    const crashSession = "00000000-0000-0000-0000-000000000107";
    const crashBucket = "wd_target_000000000107";
    const abandonedSessionDir = path.join(abandonedHome, "sessions", crashBucket, crashSession);
    fs.mkdirSync(path.join(abandonedSessionDir, "agents", "main"), { recursive: true });
    fs.writeFileSync(
      path.join(abandonedSessionDir, "state.json"),
      `${JSON.stringify({
        workDir: "/workspace/target",
        agents: {
          main: {
            homedir: path.join(abandonedSessionDir, "agents", "main"),
            type: "agent",
            parentAgentId: null
          }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(abandonedHome, "session_index.jsonl"),
      `${JSON.stringify({
        sessionId: crashSession,
        sessionDir: abandonedSessionDir,
        workDir: "/workspace/target"
      })}\n`,
      "utf8"
    );
    const crashResumed = await new KimiCode029Agent(options).buildCommand({
      prompt: "Resume abandoned",
      cwd: "/workspace/target",
      options: { resumeSession: crashSession }
    });
    assert.ok(crashResumed.env?.KIMI_CODE_HOME);
    assert.notEqual(crashResumed.env.KIMI_CODE_HOME, abandonedHome);
    const crashResumedSessionDir = path.join(crashResumed.env.KIMI_CODE_HOME, "sessions", crashBucket, crashSession);
    assert.equal(fs.existsSync(path.join(crashResumedSessionDir, "state.json")), true);
    const crashResumedState = JSON.parse(fs.readFileSync(path.join(crashResumedSessionDir, "state.json"), "utf8")) as {
      agents?: { main?: { homedir?: string } };
    };
    assert.equal(crashResumedState.agents?.main?.homedir, path.join(crashResumedSessionDir, "agents", "main"));

    await Promise.all(commands.map(async (command) => command.cleanup?.()));
    await resumed.cleanup?.();
    await resumedCaptured.cleanup?.();
    await abandonedCommand.cleanup?.();
    await crashResumed.cleanup?.();
    assert.ok(isolatedDirs.every((directory) => !fs.existsSync(directory)));

    const apiKeyAgent = new KimiCode029Agent({
      model: "kimi-k3",
      ultrafuzzAuthMode: "api-key",
      ultrafuzzReasoningEffort: "low",
      apiKey: "test-key"
    });
    const apiKeyCommand = await apiKeyAgent.buildCommand({
      prompt: "API key smoke",
      cwd: "/workspace/target",
      options: {}
    });
    const apiKeyConfigDir = apiKeyCommand.env?.KIMI_SHARE_DIR;
    assert.ok(apiKeyConfigDir);
    assert.equal(apiKeyCommand.env?.KIMI_CODE_HOME, apiKeyConfigDir);
    const apiKeyConfig = fs.readFileSync(path.join(apiKeyConfigDir, "config.toml"), "utf8");
    assert.match(apiKeyConfig, /default_model = "kimi-k3"/);
    assert.match(apiKeyConfig, /\[providers\."ultrafuzz-kimi-api"\]\ntype = "kimi"\napi_key = "test-key"/);
    assert.match(apiKeyConfig, /base_url = "https:\/\/api\.moonshot\.ai\/v1"/);
    assert.match(apiKeyConfig, /\[models\."kimi-k3"\]/);
    assert.match(apiKeyConfig, /model = "k3"/);
    assert.match(apiKeyConfig, /default_effort = "low"/);
    assert.match(apiKeyConfig, /\[thinking\]\nenabled = true\neffort = "low"/u);
    assert.equal(fs.existsSync(path.join(apiKeyConfigDir, "credentials")), false);
    assert.equal(fs.existsSync(path.join(apiKeyConfigDir, "device_id")), false);
    await apiKeyCommand.cleanup?.();
    assert.equal(fs.existsSync(apiKeyConfigDir), false);

    await assert.rejects(
      new KimiCode029Agent({
        ...options,
        ultrafuzzReasoningEffort: "xhigh"
      }).buildCommand({
        prompt: "Unsupported effort",
        cwd: "/workspace/target",
        options: {}
      }),
      /reasoning/u
    );
  }
);

const localKimiCode =
  process.env.ULTRAFUZZ_KIMI_BIN ??
  path.join(process.cwd(), "node_modules", "@moonshot-ai", "kimi-code", "dist", "main.mjs");
test(
  "generated Kimi API config and argv match the real Kimi Code 0.29.1 surface",
  { skip: !runningUnderBun || !fs.existsSync(localKimiCode), timeout: 15_000 },
  async () => {
    assert.equal(execFileSync(localKimiCode, ["--version"], { encoding: "utf8" }).trim(), "0.29.1");
    const help = execFileSync(localKimiCode, ["--help"], { encoding: "utf8" });
    for (const option of ["--session", "--continue", "--model", "--prompt", "--output-format", "--add-dir", "--yolo"]) {
      assert.match(help, new RegExp(option, "u"));
    }
    assert.doesNotMatch(help, /--final-message-only/u);
    assert.doesNotMatch(help, /--print/u);
    assert.doesNotMatch(help, /--work-dir/u);
    assert.doesNotMatch(help, /--thinking/u);

    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const previousBaseUrl = process.env.KIMI_BASE_URL;
    const previousSessionHome = process.env.ULTRAFUZZ_KIMI_SESSION_HOME;
    process.env.KIMI_BASE_URL = "https://127.0.0.1:9/v1";
    process.env.ULTRAFUZZ_KIMI_SESSION_HOME = path.join(project, ".ultrafuzz", "kimi-code-sessions");
    let command: Awaited<ReturnType<InstanceType<typeof KimiCode029Agent>["buildCommand"]>>;
    try {
      command = await new KimiCode029Agent({
        model: "kimi-k3",
        ultrafuzzAuthMode: "api-key",
        ultrafuzzReasoningEffort: "max",
        apiKey: "contract-test-key"
      }).buildCommand({
        prompt: "Contract only",
        cwd: project,
        options: {}
      });
    } finally {
      if (previousBaseUrl === undefined) delete process.env.KIMI_BASE_URL;
      else process.env.KIMI_BASE_URL = previousBaseUrl;
      if (previousSessionHome === undefined) delete process.env.ULTRAFUZZ_KIMI_SESSION_HOME;
      else process.env.ULTRAFUZZ_KIMI_SESSION_HOME = previousSessionHome;
    }
    assert.ok(command.env?.KIMI_CODE_HOME);
    execFileSync(localKimiCode, ["doctor", "config", path.join(command.env.KIMI_CODE_HOME, "config.toml")], {
      encoding: "utf8"
    });
    const parserArgs = [...command.args];
    const modelIndex = parserArgs.indexOf("--model");
    assert.notEqual(modelIndex, -1);
    parserArgs[modelIndex + 1] = "missing-model-for-contract";
    const parsed = spawnSync(localKimiCode, parserArgs, {
      cwd: project,
      env: {
        ...process.env,
        KIMI_CODE_HOME: command.env.KIMI_CODE_HOME,
        KIMI_SHARE_DIR: command.env.KIMI_CODE_HOME,
        NO_PROXY: "127.0.0.1,localhost"
      },
      encoding: "utf8",
      timeout: 5_000
    });
    assert.equal(parsed.error, undefined);
    assert.notEqual(parsed.status, 0);
    assert.match(`${parsed.stdout}\n${parsed.stderr}`, /not configured|config\.invalid/u);
    assert.doesNotMatch(
      `${parsed.stdout}\n${parsed.stderr}`,
      /Cannot combine|unknown option|--final-message-only|--print|--work-dir|--thinking|--no-thinking/u
    );
    await command.cleanup?.();
  }
);

test(
  "generated Kimi subscription config infers managed K3 reasoning efforts",
  { skip: !runningUnderBun || !fs.existsSync(localKimiCode), timeout: 15_000 },
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-managed-k3-"));
    try {
      fs.mkdirSync(path.join(home, "credentials"), { recursive: true });
      fs.writeFileSync(
        path.join(home, "config.toml"),
        `default_model = "kimi-code/k3"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = "https://127.0.0.1:9/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = ["video_in", "thinking", "image_in"]
display_name = "K3"
`,
        "utf8"
      );
      fs.writeFileSync(path.join(home, "device_id"), "00000000-0000-0000-0000-000000000106\n", "utf8");
      fs.writeFileSync(
        path.join(home, "credentials", "kimi-code.json"),
        `${JSON.stringify({
          access_token: "contract-access-token",
          refresh_token: "contract-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          expires_in: 900,
          token_type: "Bearer",
          scope: "openid"
        })}\n`,
        "utf8"
      );

      const project = tempProject();
      assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
      const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
      const command = await new KimiCode029Agent({
        model: "kimi-k3",
        ultrafuzzAuthMode: "subscription",
        ultrafuzzReasoningEffort: "max",
        configDir: home
      }).buildCommand({
        prompt: "Contract only",
        cwd: project,
        options: {}
      });
      assert.ok(command.env?.KIMI_CODE_HOME);
      const configPath = path.join(command.env.KIMI_CODE_HOME, "config.toml");
      const configText = fs.readFileSync(configPath, "utf8");
      assert.match(configText, /\[models\.(?:"kimi-k3"|kimi-k3)\]/u);
      assert.match(configText, /support_efforts\s*=\s*\[\s*"low",\s*"high",\s*"max"\s*\]/u);
      assert.match(configText, /default_effort\s*=\s*"max"/u);
      execFileSync(localKimiCode, ["doctor", "config", configPath], { encoding: "utf8" });
      await command.cleanup?.();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
);

test(
  "generated Kimi subscription path reflects real Kimi Code 0.29.1 rejecting near-refresh access-only credentials",
  { skip: !runningUnderBun || !fs.existsSync(localKimiCode), timeout: 15_000 },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kimi-frozen-auth-"));
    try {
      fs.mkdirSync(path.join(home, "credentials"), { recursive: true });
      fs.writeFileSync(
        path.join(home, "config.toml"),
        `default_model = "kimi-k3"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = "https://127.0.0.1:9/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"

[models.kimi-k3]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]
support_efforts = [ "low", "high", "max" ]
default_effort = "max"

[thinking]
enabled = true
`,
        "utf8"
      );
      fs.writeFileSync(path.join(home, "device_id"), "00000000-0000-0000-0000-000000000105\n", "utf8");
      fs.writeFileSync(
        path.join(home, "credentials", "kimi-code.json"),
        `${JSON.stringify({
          access_token: "contract-access-token",
          expires_at: Math.floor(Date.now() / 1000) + 60,
          expires_in: 900,
          token_type: "Bearer",
          scope: "openid"
        })}\n`,
        "utf8"
      );
      execFileSync(localKimiCode, ["doctor", "config", path.join(home, "config.toml")], { encoding: "utf8" });
      const parsed = spawnSync(
        localKimiCode,
        ["--output-format", "text", "--model", "kimi-k3", "--prompt", "Contract only"],
        {
          cwd: home,
          env: {
            ...process.env,
            KIMI_CODE_HOME: home,
            KIMI_SHARE_DIR: home,
            NO_PROXY: "127.0.0.1,localhost"
          },
          encoding: "utf8",
          timeout: 5_000
        }
      );
      assert.equal(parsed.error, undefined);
      assert.notEqual(parsed.status, 0);
      assert.match(`${parsed.stdout}\n${parsed.stderr}`, /login_required|refresh_token|no-refresh-token/u);
      assert.doesNotMatch(
        `${parsed.stdout}\n${parsed.stderr}`,
        /Cannot combine|unknown option|--final-message-only|--yolo/u
      );
      const credential = JSON.parse(fs.readFileSync(path.join(home, "credentials", "kimi-code.json"), "utf8")) as {
        refresh_token?: string;
      };
      assert.equal(credential.refresh_token, undefined);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
);

type KimiInterpreterEvent = {
  type?: string;
  ok?: boolean;
  answer?: string;
  resume?: string;
  usage?: Record<string, number>;
};

function writeKimiSourceConfig(project: string, name: string): string {
  const sourceConfig = path.join(project, name);
  fs.mkdirSync(path.join(sourceConfig, "credentials"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceConfig, "config.toml"),
    `default_model = "kimi-k3"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
oauth = { storage = "file", key = "oauth/kimi-code" }

[models.kimi-k3]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
support_efforts = [ "low", "high", "max" ]
default_effort = "high"
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(sourceConfig, "credentials", "kimi-code.json"),
    JSON.stringify({
      access_token: "usage-access-token",
      refresh_token: "usage-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600
    }),
    "utf8"
  );
  fs.writeFileSync(path.join(sourceConfig, "device_id"), "usage-device\n", "utf8");
  return sourceConfig;
}

function kimiSubscriptionOptions(sourceConfig: string): Record<string, unknown> {
  return {
    model: "kimi-k3",
    configDir: sourceConfig,
    ultrafuzzAuthMode: "subscription",
    ultrafuzzReasoningEffort: "max"
  };
}

function kimiUsageRecordLine(
  inputOther: number,
  output: number,
  inputCacheRead: number,
  inputCacheCreation: number
): string {
  return JSON.stringify({
    type: "usage.record",
    model: "kimi-k3",
    usage: { inputOther, output, inputCacheRead, inputCacheCreation },
    usageScope: "turn"
  });
}

/** Writes `<home>/sessions/<sessionRelative>/agents/<agentId>/wire.jsonl`. */
function writeKimiWire(home: string, sessionRelative: string, agentId: string, lines: string[]): string {
  const agentDir = path.join(home, "sessions", ...sessionRelative.split("/"), "agents", agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  const wire = path.join(agentDir, "wire.jsonl");
  fs.writeFileSync(wire, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
  return wire;
}

function kimiWireHeaderLine(sessionId: string): string {
  return JSON.stringify({ type: "metadata", version: "1.4", sessionId, createdAt: "2026-07-09T00:00:00.000Z" });
}

function kimiExitResult(args: string[]): unknown {
  return {
    command: "kimi",
    args,
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false
  };
}

function kimiCompletedEvent(events: unknown): KimiInterpreterEvent {
  const completed = (events as KimiInterpreterEvent[]).find((event) => event.type === "completed");
  assert.ok(completed !== undefined, "the Kimi interpreter emitted no completed event");
  return completed;
}

test(
  "generated Kimi adapter reports one invocation's wire usage across every agent wire",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-usage-fresh");

    const agent = new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig));
    const command = await agent.buildCommand({ prompt: "Fresh usage", cwd: "/workspace/target", options: {} });
    const home = command.env?.KIMI_CODE_HOME;
    assert.ok(home);

    const session = "00000000-0000-0000-0000-000000000201";
    const sessionRelative = `wd_target_000000000201/${session}`;
    writeKimiWire(home, sessionRelative, "main", [
      kimiWireHeaderLine(session),
      kimiUsageRecordLine(1_200, 340, 8_000, 500),
      JSON.stringify({ type: "message.appended", role: "assistant", content: "no usage on this record" }),
      kimiUsageRecordLine(90, 12, 0, 0)
    ]);
    writeKimiWire(home, sessionRelative, "sub-1", [
      kimiWireHeaderLine(session),
      kimiUsageRecordLine(700, 60, 1_000, 0)
    ]);

    const completed = kimiCompletedEvent(agent.createOutputInterpreter().onExit?.(kimiExitResult(command.args)));
    // Independent components, summed across the main agent and its sub-agent.
    assert.deepEqual(completed.usage, {
      input_tokens: 1_990,
      output_tokens: 412,
      cache_read_input_tokens: 9_000,
      cache_creation_input_tokens: 500,
      total_tokens: 11_902
    });
    // Kimi folds thinking tokens into `output`; a reasoning alias would double count.
    assert.equal(Object.prototype.hasOwnProperty.call(completed.usage ?? {}, "reasoning_tokens"), false);
    assert.equal(completed.usage?.cache_read_input_tokens !== undefined, true);
    // Attaching usage leaves the rest of the completed event untouched.
    assert.equal(completed.ok, true);

    await command.cleanup?.();
    // Cleanup clears the per-invocation baseline and runtime home, so a reused
    // agent instance cannot re-report the previous invocation's tokens.
    const afterCleanup = kimiCompletedEvent(agent.createOutputInterpreter().onExit?.(kimiExitResult(command.args)));
    assert.equal(Object.prototype.hasOwnProperty.call(afterCleanup, "usage"), false);
  }
);

test(
  "generated Kimi adapter reports only the resumed invocation's own tokens",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-usage-resume");

    const session = "00000000-0000-0000-0000-000000000202";
    const bucket = "wd_target_000000000202";
    const sessionDir = path.join(sourceConfig, "sessions", bucket, session);
    writeKimiWire(sourceConfig, `${bucket}/${session}`, "main", [
      kimiWireHeaderLine(session),
      kimiUsageRecordLine(5_000_000, 400_000, 9_000_000, 100_000),
      kimiUsageRecordLine(1_000, 2_000, 3_000, 4_000)
    ]);
    fs.writeFileSync(
      path.join(sessionDir, "state.json"),
      `${JSON.stringify({
        workDir: "/workspace/target",
        agents: {
          main: { homedir: path.join(sessionDir, "agents", "main"), type: "agent", parentAgentId: null }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(sourceConfig, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: session, sessionDir, workDir: "/workspace/target" })}\n`,
      "utf8"
    );

    const agent = new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig));
    const command = await agent.buildCommand({
      prompt: "Resume usage",
      cwd: "/workspace/target",
      options: { resumeSession: session }
    });
    const home = command.env?.KIMI_CODE_HOME;
    assert.ok(home);
    const runtimeWire = path.join(home, "sessions", bucket, session, "agents", "main", "wire.jsonl");
    assert.equal(fs.existsSync(runtimeWire), true);

    fs.appendFileSync(
      runtimeWire,
      `${kimiUsageRecordLine(1_500, 250, 6_000, 700)}\n${kimiUsageRecordLine(10, 20, 30, 40)}\n`,
      "utf8"
    );

    // The seeded history really is present, so the reported delta is the
    // baseline skipping it rather than an empty resumed wire.
    assert.equal(
      fs
        .readFileSync(runtimeWire, "utf8")
        .split("\n")
        .filter((line) => line.includes('"usage.record"')).length,
      4
    );

    const completed = kimiCompletedEvent(agent.createOutputInterpreter().onExit?.(kimiExitResult(command.args)));
    assert.deepEqual(completed.usage, {
      input_tokens: 1_510,
      output_tokens: 270,
      cache_read_input_tokens: 6_030,
      cache_creation_input_tokens: 740,
      total_tokens: 8_550
    });
    // Session recovery still reports the resumed session alongside the usage.
    assert.equal(completed.resume, session);
    assert.equal(completed.ok, true);
    await command.cleanup?.();
  }
);

test(
  "generated Kimi adapter reports failed-attempt usage and excludes it from a resumed retry",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-usage-failed-retry");
    const agent = new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig));
    const originalBuildCommand = agent.buildCommand.bind(agent);
    const session = "00000000-0000-0000-0000-000000000207";
    const bucket = "wd_target_000000000207";
    let invocation = 0;

    agent.buildCommand = async (params) => {
      const command = await originalBuildCommand(params);
      const home = command.env?.KIMI_CODE_HOME;
      assert.ok(home);
      invocation += 1;
      const sessionDir = path.join(home, "sessions", bucket, session);
      const wire = path.join(sessionDir, "agents", "main", "wire.jsonl");
      const script =
        invocation === 1
          ? [
              'const fs = require("node:fs");',
              'const path = require("node:path");',
              `const home = ${JSON.stringify(home)};`,
              `const sessionDir = ${JSON.stringify(sessionDir)};`,
              `const wire = ${JSON.stringify(wire)};`,
              "fs.mkdirSync(path.dirname(wire), { recursive: true });",
              `fs.writeFileSync(wire, ${JSON.stringify(`${kimiUsageRecordLine(101, 23, 400, 7)}\n`)});`,
              `fs.writeFileSync(path.join(sessionDir, "state.json"), ${JSON.stringify(
                `${JSON.stringify({
                  workDir: project,
                  agents: {
                    main: { homedir: path.join(sessionDir, "agents", "main"), type: "agent", parentAgentId: null }
                  }
                })}\n`
              )});`,
              `fs.writeFileSync(path.join(home, "session_index.jsonl"), ${JSON.stringify(
                `${JSON.stringify({ sessionId: session, sessionDir, workDir: project })}\n`
              )});`,
              `console.log(${JSON.stringify(
                JSON.stringify({
                  role: "meta",
                  type: "session.resume_hint",
                  session_id: session,
                  command: `kimi -r ${session}`,
                  content: `To resume this session: kimi -r ${session}`
                })
              )});`,
              "process.exit(17);"
            ].join("\n")
          : [
              'const fs = require("node:fs");',
              `const wire = ${JSON.stringify(wire)};`,
              `fs.appendFileSync(wire, ${JSON.stringify(`${kimiUsageRecordLine(11, 5, 30, 2)}\n`)});`
            ].join("\n");
      return {
        ...command,
        command: "/usr/bin/env",
        args: ["node", "-e", script],
        stdin: undefined,
        outputFormat: "stream-json"
      };
    };

    let failure: unknown;
    try {
      await agent.generate({ prompt: "Fail after usage", rootDir: project });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.deepEqual((failure as Error & { usage?: unknown }).usage, {
      inputTokens: 101,
      outputTokens: 23,
      inputTokenDetails: { cacheReadTokens: 400, cacheWriteTokens: 7 },
      totalTokens: 531
    });
    assert.equal(agent.issuedSessionId, session);

    const retried = await agent.generate({
      prompt: "Resume after failure",
      rootDir: project,
      resumeSession: session
    });
    const retryUsage = retried.usage as {
      inputTokens?: number;
      outputTokens?: number;
      inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
      totalTokens?: number;
    };
    assert.equal(retryUsage.inputTokens, 11);
    assert.equal(retryUsage.outputTokens, 5);
    assert.equal(retryUsage.inputTokenDetails?.cacheReadTokens, 30);
    assert.equal(retryUsage.inputTokenDetails?.cacheWriteTokens, 2);
    assert.equal(retryUsage.totalTokens, 48);
  }
);

test(
  "generated Kimi adapter skips malformed wire usage without fabricating tokens",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-usage-malformed");
    const options = kimiSubscriptionOptions(sourceConfig);

    const tolerant = new KimiCode029Agent(options);
    const tolerantCommand = await tolerant.buildCommand({
      prompt: "Malformed usage",
      cwd: "/workspace/target",
      options: {}
    });
    const tolerantHome = tolerantCommand.env?.KIMI_CODE_HOME;
    assert.ok(tolerantHome);
    const tolerantWire = writeKimiWire(tolerantHome, "wd_target_000000000203/session-203", "main", [
      "not json at all",
      "{",
      JSON.stringify({
        type: "usage.record",
        usage: { inputOther: "12", output: 1, inputCacheRead: 0, inputCacheCreation: 0 }
      }),
      JSON.stringify({
        type: "usage.record",
        usage: { inputOther: -5, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }
      }),
      JSON.stringify({ type: "usage.record", usage: { inputOther: 4, output: 2, inputCacheRead: 1 } }),
      JSON.stringify({ type: "usage.record", model: "kimi-k3" }),
      JSON.stringify({ type: "message.appended", usage: { inputOther: 999, output: 999 } }),
      kimiUsageRecordLine(33, 7, 2, 1)
    ]);
    // A torn final line, exactly as a crashed Kimi process leaves it.
    fs.appendFileSync(tolerantWire, '{"type":"usage.record","model":"kimi-k3","usage":{"inputOth', "utf8");

    const tolerantCompleted = kimiCompletedEvent(
      tolerant.createOutputInterpreter().onExit?.(kimiExitResult(tolerantCommand.args))
    );
    assert.deepEqual(tolerantCompleted.usage, {
      input_tokens: 33,
      output_tokens: 7,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
      total_tokens: 43
    });
    await tolerantCommand.cleanup?.();

    const absent = new KimiCode029Agent(options);
    const absentCommand = await absent.buildCommand({ prompt: "No usage", cwd: "/workspace/target", options: {} });
    const absentHome = absentCommand.env?.KIMI_CODE_HOME;
    assert.ok(absentHome);
    writeKimiWire(absentHome, "wd_target_000000000204/session-204", "main", [
      kimiWireHeaderLine("session-204"),
      "still not json",
      JSON.stringify({ type: "usage.record", usage: { inputOther: Number.NaN } })
    ]);
    const absentCompleted = kimiCompletedEvent(
      absent.createOutputInterpreter().onExit?.(kimiExitResult(absentCommand.args))
    );
    // Absent usage stays absent so accounting reports it unavailable, not zero,
    // and the successful-output and session behavior is unchanged.
    assert.equal(Object.prototype.hasOwnProperty.call(absentCompleted, "usage"), false);
    assert.equal(absentCompleted.type, "completed");
    assert.equal(absentCompleted.ok, true);
    assert.equal(absentCompleted.resume, undefined);
    await absentCommand.cleanup?.();
  }
);

test(
  "generated Kimi adapter reads wire usage only from inside the isolated runtime home",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-usage-isolation");
    // A shared session store outside this invocation's runtime home.
    writeKimiWire(sourceConfig, "wd_other/session-other", "main", [
      kimiUsageRecordLine(9_000_000, 9_000_000, 9_000_000, 9_000_000)
    ]);

    const agent = new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig));
    const command = await agent.buildCommand({ prompt: "Isolated usage", cwd: "/workspace/target", options: {} });
    const home = command.env?.KIMI_CODE_HOME;
    assert.ok(home);

    const escaped = path.join(project, "kimi-escaped-wire");
    fs.mkdirSync(escaped, { recursive: true });
    fs.writeFileSync(
      path.join(escaped, "wire.jsonl"),
      `${kimiUsageRecordLine(7_000_000, 7_000_000, 7_000_000, 7_000_000)}\n`,
      "utf8"
    );
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.symlinkSync(escaped, path.join(home, "sessions", "linked-agent-dir"), "dir");
    fs.symlinkSync(path.join(escaped, "wire.jsonl"), path.join(home, "sessions", "wire.jsonl"));
    writeKimiWire(home, "wd_target_000000000205/session-205", "main", [kimiUsageRecordLine(11, 22, 33, 44)]);

    const completed = kimiCompletedEvent(agent.createOutputInterpreter().onExit?.(kimiExitResult(command.args)));
    assert.deepEqual(completed.usage, {
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 33,
      cache_creation_input_tokens: 44,
      total_tokens: 110
    });
    await command.cleanup?.();
  }
);

test(
  "generated Kimi adapter fails telemetry closed on unsafe wire bounds and replacement",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-usage-bounds");
    const options = kimiSubscriptionOptions(sourceConfig);

    const oversized = new KimiCode029Agent(options);
    const oversizedCommand = await oversized.buildCommand({
      prompt: "Oversized usage wire",
      cwd: "/workspace/target",
      options: {}
    });
    const oversizedHome = oversizedCommand.env?.KIMI_CODE_HOME;
    assert.ok(oversizedHome);
    const oversizedWire = writeKimiWire(oversizedHome, "wd_target_000000000208/session-208", "main", [
      kimiUsageRecordLine(9, 8, 7, 6)
    ]);
    fs.appendFileSync(oversizedWire, "x".repeat(1024 * 1024 + 1), "utf8");
    const oversizedCompleted = kimiCompletedEvent(
      oversized.createOutputInterpreter().onExit?.(kimiExitResult(oversizedCommand.args))
    );
    assert.equal(Object.prototype.hasOwnProperty.call(oversizedCompleted, "usage"), false);
    await oversizedCommand.cleanup?.();

    const overflowing = new KimiCode029Agent(options);
    const overflowingCommand = await overflowing.buildCommand({
      prompt: "Overflowing usage values",
      cwd: "/workspace/target",
      options: {}
    });
    const overflowingHome = overflowingCommand.env?.KIMI_CODE_HOME;
    assert.ok(overflowingHome);
    writeKimiWire(overflowingHome, "wd_target_000000000209/session-209", "main", [
      kimiUsageRecordLine(Number.MAX_SAFE_INTEGER, 0, 0, 0),
      // Each component total is independently safe, but the combined total is not.
      kimiUsageRecordLine(0, 1, 0, 0)
    ]);
    const overflowingCompleted = kimiCompletedEvent(
      overflowing.createOutputInterpreter().onExit?.(kimiExitResult(overflowingCommand.args))
    );
    assert.equal(Object.prototype.hasOwnProperty.call(overflowingCompleted, "usage"), false);
    await overflowingCommand.cleanup?.();

    const tooMany = new KimiCode029Agent(options);
    const tooManyCommand = await tooMany.buildCommand({
      prompt: "Too many usage wires",
      cwd: "/workspace/target",
      options: {}
    });
    const tooManyHome = tooManyCommand.env?.KIMI_CODE_HOME;
    assert.ok(tooManyHome);
    for (let index = 0; index < 513; index += 1) {
      writeKimiWire(tooManyHome, "wd_target_000000000211/session-211", `agent-${index.toString().padStart(3, "0")}`, [
        kimiUsageRecordLine(1, 1, 0, 0)
      ]);
    }
    const tooManyCompleted = kimiCompletedEvent(
      tooMany.createOutputInterpreter().onExit?.(kimiExitResult(tooManyCommand.args))
    );
    assert.equal(Object.prototype.hasOwnProperty.call(tooManyCompleted, "usage"), false);
    await tooManyCommand.cleanup?.();

    const session = "00000000-0000-0000-0000-000000000210";
    const bucket = "wd_target_000000000210";
    const storedSessionDir = path.join(sourceConfig, "sessions", bucket, session);
    writeKimiWire(sourceConfig, `${bucket}/${session}`, "main", [kimiUsageRecordLine(1_000, 200, 3_000, 40)]);
    fs.writeFileSync(
      path.join(storedSessionDir, "state.json"),
      `${JSON.stringify({
        workDir: "/workspace/target",
        agents: {
          main: { homedir: path.join(storedSessionDir, "agents", "main"), type: "agent", parentAgentId: null }
        }
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(sourceConfig, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: session, sessionDir: storedSessionDir, workDir: "/workspace/target" })}\n`,
      "utf8"
    );
    const replaced = new KimiCode029Agent(options);
    const replacedCommand = await replaced.buildCommand({
      prompt: "Replaced resumed wire",
      cwd: "/workspace/target",
      options: { resumeSession: session }
    });
    const replacedHome = replacedCommand.env?.KIMI_CODE_HOME;
    assert.ok(replacedHome);
    const runtimeWire = path.join(replacedHome, "sessions", bucket, session, "agents", "main", "wire.jsonl");
    fs.rmSync(runtimeWire);
    fs.writeFileSync(runtimeWire, `${kimiUsageRecordLine(99, 88, 77, 66)}\n`, "utf8");
    const replacedCompleted = kimiCompletedEvent(
      replaced.createOutputInterpreter().onExit?.(kimiExitResult(replacedCommand.args))
    );
    assert.equal(Object.prototype.hasOwnProperty.call(replacedCompleted, "usage"), false);
    await replacedCommand.cleanup?.();
  }
);

test(
  "generated Kimi completed-event usage is what pinned Smithers 0.32.0 consumes",
  { skip: !runningUnderBun },
  async () => {
    const smithersEntry = fs.realpathSync(
      path.join(process.cwd(), "node_modules", "smithers-orchestrator", "src", "index.js")
    );
    const resolved = createRequire(smithersEntry).resolve("@smithers-orchestrator/agents/BaseCliAgent");
    const baseCliAgent = (await import(pathToFileURL(resolved).href)) as {
      extractUsageFromOutput: (raw: string) => unknown;
    };
    // A realistic Kimi Code 0.29.1 stream-json transcript: no `usage` anywhere,
    // so BaseCliAgent provably falls through to the completed event we populate.
    const streamJson = [
      JSON.stringify({ role: "meta", type: "system.version", version: "0.29.1" }),
      JSON.stringify({ role: "assistant", content: "Reviewing the target contracts." }),
      JSON.stringify({ role: "tool", tool_call_id: "call_1", content: "read 42 lines" }),
      JSON.stringify({ role: "assistant", content: "Done." }),
      JSON.stringify({
        type: "goal.summary",
        goalId: "goal_1",
        status: "completed",
        reason: null,
        turnsUsed: 3,
        tokensUsed: 4_242,
        wallClockMs: 9_000
      }),
      JSON.stringify({
        role: "meta",
        type: "session.resume_hint",
        session_id: "00000000-0000-0000-0000-000000000206",
        command: "kimi -r 00000000-0000-0000-0000-000000000206",
        content: "To resume this session: kimi -r 00000000-0000-0000-0000-000000000206"
      })
    ].join("\n");
    assert.equal(baseCliAgent.extractUsageFromOutput(streamJson), undefined);

    // The completed-event fallback reads these exact aliases; a Smithers bump
    // that renames them must fail here rather than silently drop accounting.
    const pinnedSource = fs.readFileSync(path.join(path.dirname(resolved), "BaseCliAgent.js"), "utf8");
    assert.match(pinnedSource, /usageFromCompletedEvent\(completedEvent\)/u);
    for (const alias of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens"
    ]) {
      assert.ok(pinnedSource.includes(alias), `pinned BaseCliAgent no longer reads ${alias}`);
    }
  }
);

test("validate rejects unknown agent references before launch", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  const generatedConfig = fs.readFileSync(configPath, "utf8");
  assert.match(generatedConfig, /\[agents\.CodexAgent\]/);
  assert.match(generatedConfig, /auth = "api-key"/);
  fs.writeFileSync(configPath, generatedConfig.replace('agent = "CodexAgent"', 'agent = "MissingAgent"'), "utf8");

  const validate = await validateProject({ projectRoot: project, env: {} });
  assert.equal(validate.ok, false);
  assert.ok(validate.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN"));

  const run = await startRun({
    projectRoot: project,
    runId: "unknown-agent",
    agent: "MissingAgent",
    env: fakeSmithersEnv(project)
  });
  assert.equal(run.ok, false);
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN"));
});

test("validate ignores unused opt-in model profiles in older agent registries", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  writeSmallTopology(project);
  fs.writeFileSync(
    path.join(project, ".smithers/agents/index.ts"),
    'export { createCodexAgent } from "./codex";\n' +
      "export const agentFactories = { CodexAgent: createCodexAgent };\n",
    "utf8"
  );

  const validate = await validateProject({ projectRoot: project, env: {} });
  assert.equal(validate.ok, true, JSON.stringify(validate.diagnostics));

  const kimiRun = await startRun({
    projectRoot: project,
    runId: "missing-kimi-agent",
    agent: "KimiAgent",
    env: fakeSmithersEnv(project)
  });
  assert.equal(kimiRun.ok, false);
  assert.ok(kimiRun.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN"));
});

test("init and run layout reject symlinked project-owned roots before writes", async () => {
  const project = tempProject();
  const outside = tempProject();
  fs.symlinkSync(outside, path.join(project, ".ultrafuzz"));

  const init = initProject({ projectRoot: project });
  assert.equal(init.ok, false);
  assert.ok(init.diagnostics.some((diagnostic) => diagnostic.code === "INIT_ROOT_UNSAFE"));
  assert.equal(fs.existsSync(path.join(outside, "runs")), false);
});

test("force init rejects symlinked config and nested project files before overwrite", async () => {
  const configProject = tempProject();
  const configOutside = tempProject();
  fs.writeFileSync(path.join(configOutside, "ultrafuzz.toml"), "outside\n", "utf8");
  fs.symlinkSync(path.join(configOutside, "ultrafuzz.toml"), path.join(configProject, "ultrafuzz.toml"));
  const configInit = initProject({ projectRoot: configProject, force: true });
  assert.equal(configInit.ok, false);
  assert.ok(configInit.diagnostics.some((diagnostic) => diagnostic.code === "INIT_PATH_UNSAFE"));
  assert.equal(fs.readFileSync(path.join(configOutside, "ultrafuzz.toml"), "utf8"), "outside\n");

  const topologyProject = tempProject();
  const topologyOutside = tempProject();
  fs.mkdirSync(path.join(topologyProject, ".ultrafuzz"), { recursive: true });
  fs.writeFileSync(path.join(topologyOutside, "topology.yml"), "outside\n", "utf8");
  fs.symlinkSync(path.join(topologyOutside, "topology.yml"), path.join(topologyProject, ".ultrafuzz", "topology.yml"));
  const topologyInit = initProject({ projectRoot: topologyProject, force: true });
  assert.equal(topologyInit.ok, false);
  assert.ok(topologyInit.diagnostics.some((diagnostic) => diagnostic.code === "INIT_PATH_UNSAFE"));
  assert.equal(fs.readFileSync(path.join(topologyOutside, "topology.yml"), "utf8"), "outside\n");
});

test("plan creates run layout, graph fingerprint, and rendered prompt before Smithers submission", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const plan = await planRun({ projectRoot: project, runId: "planned-run", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(fs.existsSync(path.join(plan.value!.run_root, "plan.json")), true);
  assert.equal(fs.existsSync(path.join(plan.value!.run_root, "artifacts/project-discovery/prompt.rendered.md")), true);
  const persistedPlan = JSON.parse(fs.readFileSync(path.join(plan.value!.run_root, "plan.json"), "utf8")) as {
    execution?: { mode?: string; retentionDays?: number };
    rendered_prompts: Array<{ rendered_prompt_snapshot_path?: string }>;
  };
  assert.deepEqual(persistedPlan.execution, plan.value!.resolved_config.execution);
  assert.equal(persistedPlan.rendered_prompts.length, 1);
  assert.match(persistedPlan.rendered_prompts[0]!.rendered_prompt_snapshot_path ?? "", /^prompt-snapshots\//u);
  assert.equal(
    fs.existsSync(path.join(plan.value!.run_root, persistedPlan.rendered_prompts[0]!.rendered_prompt_snapshot_path!)),
    true
  );
  assert.match(plan.value!.graph_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(plan.value!.graph.nodes[0]?.model_fanout[0]?.agent_ref, "CodexAgent");
});

test("plan wires the inclusive invariant priority selection into rendered prompts", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  fs.mkdirSync(path.join(project, ".ultrafuzz", "prompts", "test"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "test", "priority.md"),
    `---
id: priority-plumbing-test
display_name: Priority plumbing test
---
Threshold={{invariant_property_priority_threshold}}
Filter={{invariant_property_priority_filter}}
Priorities={{invariant_property_priorities}}
`,
    "utf8"
  );
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
  - id: priority-plumbing-test
    kind: agentic
    prompt: test/priority.md
    depends_on:
      - __start__
    outputs:
      - path: findings.json
        contract: ultrafuzz/findings@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - priority-plumbing-test
`,
    "utf8"
  );

  const plan = await planRun({ projectRoot: project, runId: "priority-plumbing", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const promptPath = plan.value!.rendered_prompts[0]!.rendered_prompt_path;
  const rendered = fs.readFileSync(promptPath, "utf8");
  assert.match(rendered, /Threshold=high/u);
  assert.match(rendered, /Filter=properties with priority at or above `high`/u);
  assert.match(rendered, /Priorities=high/u);
});

test("repairs only missing rendered prompts from compatible persisted run metadata", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "prompt-repair", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const promptPath = path.join(plan.value!.run_root, "artifacts", "project-discovery", "prompt.rendered.md");
  const expected = fs.readFileSync(promptPath, "utf8");
  fs.rmSync(promptPath);

  assert.equal(
    await repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "prompt-repair",
      runRoot: plan.value!.run_root
    }),
    1
  );
  assert.equal(fs.readFileSync(promptPath, "utf8"), expected);
  assert.equal(
    await repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "prompt-repair",
      runRoot: plan.value!.run_root
    }),
    0
  );
});

test("serializes concurrent prompt repairs without deleting another invocation's output", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "concurrent-prompt-repair", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const promptPath = plan.value!.rendered_prompts[0]!.rendered_prompt_path;
  const expected = fs.readFileSync(promptPath, "utf8");
  fs.rmSync(promptPath);

  const repair = () =>
    repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "concurrent-prompt-repair",
      runRoot: plan.value!.run_root
    });
  assert.deepEqual((await Promise.all([repair(), repair()])).sort(), [0, 1]);
  assert.equal(fs.readFileSync(promptPath, "utf8"), expected);
  assert.equal(fs.existsSync(path.join(plan.value!.run_root, ".prompt-repair")), false);
});

test("repairs from immutable bytes after prompt-affecting runtime overrides and source changes", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const sourcePrompt = path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md");
  fs.appendFileSync(sourcePrompt, "\nOriginal quorum: {{triage_quorum}} of {{triage_panel_size}}.\n", "utf8");
  const plan = await planRun({
    projectRoot: project,
    runId: "prompt-repair-runtime-override",
    runtimeOverrides: { triageQuorum: 6, triagePanelSize: 7 },
    env: {}
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const promptPath = plan.value!.rendered_prompts[0]!.rendered_prompt_path;
  const expected = fs.readFileSync(promptPath, "utf8");
  assert.match(expected, /Original quorum: 6 of 7\./u);
  fs.rmSync(promptPath);
  fs.appendFileSync(sourcePrompt, "\nChanged after planning.\n", "utf8");
  fs.writeFileSync(path.join(project, "ultrafuzz.toml"), "not valid toml = [\n", "utf8");

  assert.equal(
    await repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "prompt-repair-runtime-override",
      runRoot: plan.value!.run_root
    }),
    1
  );
  assert.equal(fs.readFileSync(promptPath, "utf8"), expected);
});

test("refuses all digest-less legacy prompt reuse because original lineage is unprovable", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "legacy-prompt-repair", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const planPath = path.join(plan.value!.run_root, "plan.json");
  const persisted = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
    rendered_prompts: Array<Record<string, unknown>>;
  };
  persisted.rendered_prompts = persisted.rendered_prompts.map(
    ({ rendered_prompt_digest: _digest, rendered_prompt_snapshot_path: _snapshot, ...entry }) => ({
      ...entry,
      rendered_prompt_path: path.join("/__legacy_volume_mount", String(entry.rendered_prompt_path).replace(/^\/+/u, ""))
    })
  );
  fs.writeFileSync(planPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

  await assert.rejects(
    repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "legacy-prompt-repair",
      runRoot: plan.value!.run_root
    }),
    /cannot validate legacy rendered prompt/u
  );
});

test("refuses rendered prompt repair when its immutable snapshot does not match the persisted digest", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "prompt-lineage", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const prompt = plan.value!.rendered_prompts[0]!;
  const persisted = JSON.parse(fs.readFileSync(path.join(plan.value!.run_root, "plan.json"), "utf8")) as {
    rendered_prompts: Array<{ rendered_prompt_snapshot_path: string }>;
  };
  const snapshotPath = path.join(plan.value!.run_root, persisted.rendered_prompts[0]!.rendered_prompt_snapshot_path);
  fs.rmSync(prompt.rendered_prompt_path);
  fs.appendFileSync(snapshotPath, "\n.\n", "utf8");

  await assert.rejects(
    repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "prompt-lineage",
      runRoot: plan.value!.run_root
    }),
    /immutable rendered prompt snapshot does not match persisted task metadata/u
  );
  assert.equal(fs.existsSync(prompt.rendered_prompt_path), false);
});

test("refuses to reuse an existing rendered prompt that does not match its persisted digest", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "prompt-validation", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const prompt = plan.value!.rendered_prompts[0]!;
  fs.appendFileSync(prompt.rendered_prompt_path, "\n.\n", "utf8");

  await assert.rejects(
    repairMissingRenderedPromptsForRun({
      projectRoot: project,
      runId: "prompt-validation",
      runRoot: plan.value!.run_root
    }),
    /existing rendered prompt does not match persisted task metadata/u
  );
});

test("plan uses an eval topology override without replacing the project topology", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const canonicalTopology = path.join(project, ".ultrafuzz", "topology.yml");
  const smokeTopology = path.join(project, "smoke-benchmark.yml");
  fs.copyFileSync(canonicalTopology, smokeTopology);
  fs.writeFileSync(canonicalTopology, "not: [valid\n", "utf8");

  const plan = await planRun({
    projectRoot: project,
    topologyPath: smokeTopology,
    runId: "topology-override",
    env: {}
  });

  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.value!.validation.topology?.path, smokeTopology);
  assert.deepEqual(
    plan.value!.graph.nodes.map((node) => node.logical_id),
    ["project-discovery"]
  );
  assert.equal(fs.readFileSync(canonicalTopology, "utf8"), "not: [valid\n");
});

test("plan applies smoke eval model profiles to a normally initialized target", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  const smokeTopology = path.resolve(process.cwd(), "../..", "benchmarks", "smoke-benchmark.yml");

  const plan = await planRun({
    projectRoot: project,
    topologyPath: smokeTopology,
    runId: "smoke-topology-profiles",
    runtimeOverrides: {
      models: {
        profiles: {
          benchmark: { agent: "CodexAgent", model: "gpt-5.6-luna", reasoning: "high" },
          "smoke-coordination": { agent: "CodexAgent", model: "gpt-5.6-luna", reasoning: "medium" }
        }
      }
    },
    env: {}
  });

  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const executable = plan.value!.graph.nodes.filter((node) => node.kind === "agentic");
  assert.equal(executable.length, 7);
  const strategies = executable.filter((node) => node.model_fanout[0]?.model_profile_id === "benchmark");
  const coordination = executable.filter((node) => node.model_fanout[0]?.model_profile_id === "smoke-coordination");
  assert.equal(strategies.length, 4);
  assert.ok(strategies.every((node) => node.model_fanout[0]?.reasoning_effort === "high"));
  assert.equal(coordination.length, 3);
  assert.ok(coordination.every((node) => node.model_fanout[0]?.reasoning_effort === "medium"));

  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-smoke-topology-retries",
    renderedPrompts: plan.value!.rendered_prompts
  });
  assert.equal(compiled.tasks.length, 7);
  assert.ok(compiled.tasks.every((task) => task.retries === 2));
  assert.ok(compiled.tasks.every((task) => task.timeoutMs === 1_200_000));
  assert.ok(compiled.tasks.every((task) => task.heartbeatTimeoutMs === 1_200_000));
  assert.ok(compiled.tasks.every((task) => task.metadata.retryPolicy.maxAttempts === 3));
  assert.ok(compiled.tasks.every((task) => task.metadata.retryPolicy.smithersRetries === 2));
});

test("plan materializes pinned reference nodes before rendering dependent prompts", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeReferenceTopology(project);
  const xdgCacheHome = path.join(project, "xdg-cache");
  writeReferenceCache(xdgCacheHome);
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = xdgCacheHome;
  try {
    const plan = await planRun({ projectRoot: project, runId: "reference-plan", env: {} });

    assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
    const referenceArtifact = path.join(
      plan.value!.run_root,
      "artifacts",
      "reference-properties-example",
      "references",
      "example.md"
    );
    const referenceManifest = path.join(
      plan.value!.run_root,
      "artifacts",
      "reference-properties-example",
      RUN_REFERENCE_MANIFEST_FILE
    );
    assert.equal(fs.existsSync(referenceArtifact), true);
    assert.equal(fs.existsSync(referenceManifest), true);
    assert.match(fs.readFileSync(referenceArtifact, "utf8"), /# Pinned Reference: properties\.example/u);
    const rendered = fs.readFileSync(
      path.join(plan.value!.run_root, "artifacts", "project-discovery", "prompt.rendered.md"),
      "utf8"
    );
    assert.match(rendered, /reference-properties-example\/references\/example\.md/u);
    const state = JSON.parse(fs.readFileSync(path.join(plan.value!.run_root, "state.json"), "utf8")) as {
      nodes?: Record<string, { status?: string; provenance?: Record<string, unknown> }>;
    };
    assert.equal(state.nodes?.["reference-properties-example"]?.status, "succeeded");
    assert.equal(state.nodes?.["reference-properties-example"]?.provenance?.reference, "properties.example");
  } finally {
    if (previousXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = previousXdgCacheHome;
    }
  }
});

test("plan provisions a validated trusted expectation catalog through pinned reference handoffs", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeReferenceTopology(project);
  fs.writeFileSync(
    path.join(project, "reference-expectations.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.reference-expectations.v1",
      expectations: [{ id: "benchmark:example:supply", description: "Supply remains live." }]
    }),
    "utf8"
  );
  const xdgCacheHome = path.join(project, "xdg-cache");
  writeReferenceCache(xdgCacheHome);
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = xdgCacheHome;
  try {
    const plan = await planRun({
      projectRoot: project,
      runId: "reference-expectations-plan",
      referenceExpectationsPath: "reference-expectations.json",
      env: {}
    });

    assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
    const referenceNode = plan.value!.graph.nodes.find((node) => node.kind === "reference");
    assert.ok(referenceNode);
    assert.ok(
      referenceNode.outputs.some(
        (output) =>
          output.path === "references/expectations.json" && output.contract === "ultrafuzz/reference-expectations@1"
      )
    );
    const catalogPath = path.join(
      plan.value!.run_root,
      "artifacts",
      referenceNode.id,
      "references",
      "expectations.json"
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(catalogPath, "utf8")), {
      schema_version: "ultrafuzz.reference-expectations.v1",
      expectations: [{ id: "benchmark:example:supply", description: "Supply remains live." }]
    });
    const rendered = fs.readFileSync(
      path.join(plan.value!.run_root, "artifacts", "project-discovery", "prompt.rendered.md"),
      "utf8"
    );
    assert.match(rendered, /reference-properties-example\/references\/expectations\.json/u);
    const state = JSON.parse(fs.readFileSync(path.join(plan.value!.run_root, "state.json"), "utf8")) as {
      nodes?: Record<string, { provenance?: Record<string, unknown>; outputs?: Array<{ path?: string }> }>;
    };
    assert.equal(state.nodes?.[referenceNode.id]?.provenance?.origin, "pinned-reference");
    assert.deepEqual(state.nodes?.[referenceNode.id]?.provenance?.reference_expectations, {
      source: "operator-supplied",
      path: "reference-expectations.json",
      sha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(project, "reference-expectations.json")))
        .digest("hex")
    });
    assert.ok(
      state.nodes?.[referenceNode.id]?.outputs?.some((output) => output.path === "references/expectations.json")
    );
  } finally {
    if (previousXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = previousXdgCacheHome;
    }
  }
});

test("plan renders prompt variables against attempt artifact directories for model fan-out", async () => {
  const project = tempProject();
  writeFanoutProject(project);

  const plan = await planRun({ projectRoot: project, runId: "fanout-prompts", env: {} });

  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const setupFast = plan.value!.rendered_prompts.find(
    (prompt) => prompt.attempt_id === "project-discovery__model_0__attempt_0"
  );
  const signalFast = plan.value!.rendered_prompts.find(
    (prompt) => prompt.attempt_id === "signal-analysis__model_0__attempt_0"
  );
  assert.ok(setupFast);
  assert.ok(signalFast);

  const setupFastDir = path.join(plan.value!.run_root, "artifacts", "project-discovery__model_0__attempt_0");
  const setupDeepDir = path.join(plan.value!.run_root, "artifacts", "project-discovery__model_1__attempt_1");
  const signalFastDir = path.join(plan.value!.run_root, "artifacts", "signal-analysis__model_0__attempt_0");
  const setupText = fs.readFileSync(setupFast.rendered_prompt_path, "utf8");
  const signalText = fs.readFileSync(signalFast.rendered_prompt_path, "utf8");

  assert.ok(setupText.includes("Strategy: project-discovery"), setupText);
  assert.ok(setupText.includes(setupFastDir), setupText);
  assert.ok(signalText.includes(path.join(signalFastDir, "findings.json")), signalText);
  assert.ok(signalText.includes(path.join(setupFastDir, "setup", "project-discovery.md")), signalText);
  assert.ok(signalText.includes(path.join(setupDeepDir, "setup", "project-discovery.md")), signalText);
});

test("compileSmithersWorkflow gates native dependencies on deterministic artifact verification", async () => {
  const project = tempProject();
  writeFanoutProject(project);

  const plan = await planRun({ projectRoot: project, runId: "native-deps", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-native-deps",
    renderedPrompts: plan.value!.rendered_prompts
  });

  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  assert.match(workflowSource, /dependsOn=\{task\.dependsOn\}/);
  assert.match(workflowSource, /const taskOutput = z\.strictObject\(\{/);
  assert.match(workflowSource, /summary: z\.string\(\)\.min\(1\)/);
  assert.match(workflowSource, /smithers-display-name: Ultrafuzz native-deps/);
  assert.doesNotMatch(workflowSource, /__ULTRAFUZZ_/);
  assert.doesNotMatch(workflowSource, /const layers =/);
  assert.doesNotMatch(workflowSource, /<Sequence\b/);
  assert.match(workflowSource, /<Parallel\b/);

  const smithersTasks = JSON.parse(fs.readFileSync(compiled.tasksPath, "utf8")) as {
    layers?: unknown;
    tasks: Array<{ attemptId: string; dependencySmithersNodeIds: string[] }>;
  };
  assert.equal("layers" in smithersTasks, false);
  assert.equal(workflowSource.match(/"runtimeContext":/gu)?.length, smithersTasks.tasks.length);
  assert.deepEqual(
    smithersTasks.tasks.find((task) => task.attemptId === "project-discovery__model_0__attempt_0")
      ?.dependencySmithersNodeIds,
    []
  );
  assert.deepEqual(
    smithersTasks.tasks.find((task) => task.attemptId === "signal-analysis__model_0__attempt_0")
      ?.dependencySmithersNodeIds,
    ["verify:project-discovery__model_0__attempt_0", "verify:project-discovery__model_1__attempt_1"]
  );
  assert.match(workflowSource, /id=\{task\.verifierId\}/);
  assert.match(workflowSource, /validateArtifactContract/);
  assert.match(workflowSource, /candidate !== root && candidate\.startsWith/);
  assert.match(workflowSource, /isStrictlyInsideDirectory\(artifactDir, artifactPath\)/);
  assert.match(workflowSource, /probeCandidate === workspaceRoot/);
  assert.match(workflowSource, /relativePath\.split\("\/"\)\.includes\("\.\."\)/);
  assert.match(workflowSource, /relativePath\.includes\("\\u0000"\)/);
  assert.match(workflowSource, /realpathSync\(workspacePath\) !== workspacePath/);
  assert.match(workflowSource, /lstatSync\(current\)\.isSymbolicLink\(\)/);
});

test("compileSmithersWorkflow maps cloud attempts to portable provider sandboxes", async () => {
  const project = tempProject();
  writeFanoutProject(project);
  const promptMarker = "CLOUD_PROMPT_ONLY_PRIVATE_MARKER";
  fs.appendFileSync(
    path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md"),
    `\n${promptMarker}\n`,
    "utf8"
  );

  const plan = await planRun({ projectRoot: project, runId: "cloud-nodes", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  plan.value!.resolved_config.agents.ClaudeAgent = {
    auth: "api-key",
    apiKeyEnv: "ANTHROPIC_API_KEY"
  };
  plan.value!.resolved_config.execution = {
    mode: "cloud",
    provider: "modal",
    retentionDays: 30,
    resources: {
      cpu: 4,
      memoryMiB: 8192,
      timeoutSeconds: 1800
    },
    nodes: {
      "project-discovery": {
        resources: {
          cpu: 8,
          memoryMiB: 16384
        }
      }
    },
    providers: {
      modal: {
        app: "ultrafuzz-test",
        image: "ultrafuzz-test",
        credentialEnv: ["ULTRAFUZZ_TEST_PROVIDER_ID", "ULTRAFUZZ_TEST_PROVIDER_SECRET"]
      }
    }
  };
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-cloud-nodes",
    renderedPrompts: plan.value!.rendered_prompts
  });

  const discoveryTasks = compiled.tasks.filter((task) => task.metadata.node.logicalNodeId === "project-discovery");
  const discovery = discoveryTasks[0];
  assert.ok(discovery);
  assert.deepEqual(discovery.execution.resources, {
    cpu: 8,
    memoryMiB: 16384,
    timeoutSeconds: 1800
  });
  assert.deepEqual(
    discoveryTasks.map((task) => ({ agentRef: task.agentRef, agentAuth: task.execution.agentAuth })),
    [
      {
        agentRef: "CodexAgent",
        agentAuth: {
          agent: "CodexAgent",
          provider: "openai",
          auth: { mode: "api-key", source_env: "OPENAI_API_KEY" }
        }
      },
      {
        agentRef: "ClaudeAgent",
        agentAuth: {
          agent: "ClaudeAgent",
          provider: "anthropic",
          auth: { mode: "api-key", source_env: "ANTHROPIC_API_KEY" }
        }
      }
    ]
  );
  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  assert.match(workflowSource, /<Sandbox/);
  assert.match(workflowSource, /createModalNodeSandboxProvider/);
  assert.match(workflowSource, /schema_version: "ultrafuzz\.modal\.node\.v1"/);
  assert.match(workflowSource, /agent_auth: task\.execution\.agentAuth/);
  assert.match(workflowSource, /agent_model: task\.modelName/);
  assert.doesNotMatch(workflowSource, /agent_credential_env/);
  assert.match(workflowSource, /const cloudWorker = isCloudWorkerProcess/);
  assert.match(workflowSource, /ctx\.input\.cloud_worker === true\) !== cloudWorker/);
  assert.match(workflowSource, /run_id: "cloud-nodes"/u);
  assert.doesNotMatch(workflowSource, /run_id: cloud-nodes/u);
  assert.match(workflowSource, /execution_generation: cloudExecutionGeneration/u);
  assert.match(workflowSource, /"promptPath": "\.ultrafuzz\/runs\/cloud-nodes\//);
  assert.match(workflowSource, /"prompt": ""/u);
  assert.doesNotMatch(workflowSource, new RegExp(promptMarker, "u"));
  assert.match(workflowSource, /"workspacePath": "\.ultrafuzz\/runs\/cloud-nodes\//);
  assert.match(workflowSource, /"path": "\.ultrafuzz\/runs\/cloud-nodes\/workspaces\//);
  assert.match(workflowSource, /"dependencyArtifactDirs": \[/u);
  const fanIn = compiled.tasks.find((task) => task.metadata.node.logicalNodeId === "signal-analysis");
  assert.equal(fanIn?.dependencyArtifactDirs.length, 2);
  assert.ok(
    fanIn?.dependencyArtifactDirs.every((directory) =>
      directory.startsWith(path.join(project, ".ultrafuzz", "runs", "cloud-nodes", "artifacts"))
    )
  );
  assert.doesNotMatch(workflowSource, new RegExp(`"promptPath": ${JSON.stringify(project)}`, "u"));
  assert.match(workflowSource, /operator_prompt: operatorPromptInput/u);
});

test("compileSmithersWorkflow gives generated tests exact local and shared output roots in cloud specs", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "workspace-output-roots.md"),
    "Write outputs.\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
groups:
  strategies:
    label: Strategies
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: boundary-tests
    kind: agentic
    prompt: workspace-output-roots.md
    group: strategies
    loops: 2
    depends_on: [__start__]
    outputs:
      - path: generated-tests.json
        contract: ultrafuzz/generated-tests@1
        primary: true
  - id: reference-harness-author
    kind: agentic
    prompt: workspace-output-roots.md
    group: strategies
    depends_on: [__start__]
    outputs:
      - path: generated-tests.json
        contract: ultrafuzz/generated-tests@1
        primary: true
  - id: stateful-invariant-setup
    kind: agentic
    prompt: workspace-output-roots.md
    group: strategies
    depends_on: [__start__]
    outputs:
      - path: setup.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: stateful-invariant-implement-properties
    kind: agentic
    prompt: workspace-output-roots.md
    group: strategies
    depends_on: [__start__]
    outputs:
      - path: generated-tests.json
        contract: ultrafuzz/generated-tests@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - boundary-tests
      - reference-harness-author
      - stateful-invariant-setup
      - stateful-invariant-implement-properties
`,
    "utf8"
  );

  const plan = await planRun({ projectRoot: project, runId: "workspace-output-roots", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  plan.value!.resolved_config.execution = {
    mode: "cloud",
    provider: "modal",
    retentionDays: 30,
    resources: { cpu: 4, memoryMiB: 8192, timeoutSeconds: 1800 },
    nodes: {},
    providers: {
      modal: {
        app: "ultrafuzz-test",
        image: "ultrafuzz-test",
        credentialEnv: []
      }
    }
  };
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-workspace-output-roots",
    renderedPrompts: plan.value!.rendered_prompts
  });
  const roots = (logicalNodeId: string): readonly string[] | undefined =>
    compiled.tasks.find((task) => task.logicalNodeId === logicalNodeId)?.workspaceOutputRoots;
  const boundaryTasks = compiled.tasks.filter((task) => task.logicalNodeId === "boundary-tests");
  assert.equal(boundaryTasks.length, 2);
  assert.equal(new Set(boundaryTasks.map((task) => task.concreteNodeId)).size, 2);
  assert.ok(
    boundaryTasks.every(
      (task) =>
        JSON.stringify(task.workspaceOutputRoots) ===
        JSON.stringify([`artifacts/${task.attemptId}`, "test/foundry/boundary-tests"])
    )
  );
  assert.deepEqual(roots("reference-harness-author"), [
    "artifacts/reference-harness-author",
    "test/foundry/reference-harness-author",
    "test/foundry/differential"
  ]);
  assert.deepEqual(roots("stateful-invariant-setup"), [
    "artifacts/stateful-invariant-setup",
    "test/recon",
    "test/chimera",
    "test/invariants",
    "test/foundry/invariants"
  ]);
  assert.deepEqual(roots("stateful-invariant-implement-properties"), [
    "artifacts/stateful-invariant-implement-properties",
    "test/foundry/stateful-invariant-implement-properties",
    "test/recon",
    "test/chimera",
    "test/invariants",
    "test/foundry/invariants"
  ]);
  assert.equal(
    compiled.tasks.some((task) => task.workspaceOutputRoots.includes("test")),
    false
  );

  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  const startMarker = "const serializedTaskSpecs = ";
  const start = workflowSource.indexOf(startMarker) + startMarker.length;
  const end = workflowSource.indexOf(" as const;", start);
  assert.ok(start >= startMarker.length && end > start);
  const cloudSpecs = JSON.parse(workflowSource.slice(start, end)) as Array<{
    metadata: { node: { concreteNodeId: string; logicalNodeId: string } };
    workspaceOutputRoots: string[];
  }>;
  for (const spec of cloudSpecs) {
    const compiledTask = compiled.tasks.find((task) => task.concreteNodeId === spec.metadata.node.concreteNodeId);
    assert.ok(compiledTask);
    assert.deepEqual(spec.workspaceOutputRoots, compiledTask.workspaceOutputRoots);
    assert.equal(
      spec.workspaceOutputRoots.some((root) => path.isAbsolute(root) || root === "test"),
      false
    );
  }
});

test("compileSmithersWorkflow preserves Kimi cloud API-key binding for Modal fallback credentials", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace(
        '[agents.KimiAgent]\nauth = "subscription"',
        '[agents.KimiAgent]\nauth = "api-key"\napi_key_env = "KIMI_API_KEY"'
      ),
    "utf8"
  );

  const plan = await planRun({ projectRoot: project, runId: "cloud-kimi-nodes", agent: "KimiAgent", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  plan.value!.resolved_config.execution = {
    mode: "cloud",
    provider: "modal",
    retentionDays: 30,
    resources: { cpu: 4, memoryMiB: 8192, timeoutSeconds: 1800 },
    nodes: {},
    providers: {
      modal: {
        app: "ultrafuzz-test",
        image: "ultrafuzz-test",
        credentialEnv: ["ULTRAFUZZ_TEST_PROVIDER_ID", "ULTRAFUZZ_TEST_PROVIDER_SECRET"]
      }
    }
  };
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-cloud-kimi-nodes",
    renderedPrompts: plan.value!.rendered_prompts
  });

  const discovery = compiled.tasks.find((task) => task.metadata.node.logicalNodeId === "project-discovery");
  assert.ok(discovery);
  assert.equal(discovery.agentRef, "KimiAgent");
  assert.deepEqual(discovery.execution.agentAuth, {
    agent: "KimiAgent",
    provider: "kimi",
    auth: {
      mode: "api-key",
      source_env: "KIMI_API_KEY",
      fallback_source_env: "MOONSHOT_API_KEY",
      base_url_source_env: "KIMI_BASE_URL"
    }
  });
});

test("compileSmithersWorkflow admits only strict built-in cloud authentication descriptors", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "strict-cloud-auth", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const baseConfig = plan.value!.resolved_config;
  baseConfig.execution = {
    mode: "cloud",
    provider: "modal",
    retentionDays: 30,
    resources: { cpu: 4, memoryMiB: 8192, timeoutSeconds: 1800 },
    nodes: {},
    providers: {
      modal: {
        app: "ultrafuzz-test",
        image: "ultrafuzz-test",
        credentialEnv: ["ULTRAFUZZ_TEST_PROVIDER_ID", "ULTRAFUZZ_TEST_PROVIDER_SECRET"]
      }
    }
  };
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  let compileIndex = 0;
  const compileWith = (config: typeof baseConfig) => {
    compileIndex += 1;
    const compileRunId = `strict-cloud-auth-${compileIndex}`;
    const runLayout = layoutForRunRoot(path.join(project, ".ultrafuzz", "runs", compileRunId), compileRunId);
    fs.mkdirSync(runLayout.root, { recursive: true });
    return compileSmithersWorkflow({
      projectRoot: project,
      config,
      graph: plan.value!.expanded_graph,
      runLayout,
      workflowName: `ultrafuzz-${compileRunId}`,
      renderedPrompts: plan.value!.rendered_prompts
    });
  };
  const selectAgent = (config: typeof baseConfig, agent: string): void => {
    config.models.profiles[config.models.default]!.agent = agent;
  };

  const deepSeek = structuredClone(baseConfig);
  selectAgent(deepSeek, "DeepSeekAgent");
  const deepSeekTask = compileWith(deepSeek).tasks[0];
  assert.ok(deepSeekTask);
  assert.deepEqual(deepSeekTask.execution.agentAuth, {
    agent: "DeepSeekAgent",
    provider: "deepseek",
    auth: { mode: "api-key", source_env: "DEEPSEEK_API_KEY" }
  });

  const kimi = structuredClone(baseConfig);
  selectAgent(kimi, "KimiAgent");
  kimi.models.profiles[kimi.models.default]!.model = "kimi-k3";
  kimi.agents.KimiAgent = { auth: "subscription", configDir: "/run/ultrafuzz-auth/kimi" };
  const kimiTask = compileWith(kimi).tasks[0];
  assert.ok(kimiTask);
  assert.equal(kimiTask.modelName, "kimi-k3");
  assert.deepEqual(kimiTask.execution.agentAuth, {
    agent: "KimiAgent",
    provider: "kimi",
    auth: { mode: "subscription", config_dir: "/run/ultrafuzz-auth/kimi" }
  });
  const kimiWorkflowSource = fs.readFileSync(compileWith(kimi).workflowPath, "utf8");
  assert.match(kimiWorkflowSource, /"modelName": "kimi-k3"/u);
  assert.match(kimiWorkflowSource, /agent_model: task\.modelName/u);

  const missingKimiModel = structuredClone(kimi);
  delete missingKimiModel.models.profiles[missingKimiModel.models.default]!.model;
  assert.throws(
    () => compileWith(missingKimiModel),
    /cloud KimiAgent subscription authentication requires an exact model alias/u
  );

  for (const agent of ["CodexAgent", "ClaudeAgent", "DeepSeekAgent"] as const) {
    const unsupported = structuredClone(baseConfig);
    selectAgent(unsupported, agent);
    unsupported.agents[agent] = { auth: "subscription" };
    assert.throws(
      () => compileWith(unsupported),
      new RegExp(`does not support ${agent} subscription authentication without a trusted refresh broker`, "u")
    );
  }

  const unknown = structuredClone(baseConfig);
  selectAgent(unknown, "ThirdPartyAgent");
  unknown.agents.ThirdPartyAgent = { auth: "api-key", apiKeyEnv: "THIRD_PARTY_API_KEY" };
  assert.throws(() => compileWith(unknown), /cloud execution supports only built-in agents, not ThirdPartyAgent/u);

  const reservedSource = structuredClone(baseConfig);
  reservedSource.agents.CodexAgent = { auth: "api-key", apiKeyEnv: "NODE_OPTIONS" };
  assert.throws(
    () => compileWith(reservedSource),
    /cloud agent authentication source environment name is reserved: NODE_OPTIONS/u
  );

  const judgeSource = structuredClone(baseConfig);
  judgeSource.agents.CodexAgent = { auth: "api-key", apiKeyEnv: "OPENAI_JUDGE_API_KEY" };
  assert.throws(
    () => compileWith(judgeSource),
    /cloud execution CodexAgent\/openai API-key source must be OPENAI_API_KEY, not OPENAI_JUDGE_API_KEY/u
  );

  const crossProviderSource = structuredClone(baseConfig);
  crossProviderSource.agents.CodexAgent = { auth: "api-key", apiKeyEnv: "DEEPSEEK_API_KEY" };
  assert.throws(
    () => compileWith(crossProviderSource),
    /cloud execution CodexAgent\/openai API-key source must be OPENAI_API_KEY, not DEEPSEEK_API_KEY/u
  );

  const controllerOverlap = structuredClone(baseConfig);
  controllerOverlap.execution.providers.modal!.credentialEnv = ["OPENAI_API_KEY", "MODAL_CONTROLLER_SECRET"];
  assert.throws(
    () => compileWith(controllerOverlap),
    /cloud agent authentication source overlaps a Modal controller credential: OPENAI_API_KEY/u
  );
});

test("compileSmithersWorkflow escapes the evidence workflow import", async () => {
  const project = tempProject();
  writeFanoutProject(project);

  const plan = await planRun({ projectRoot: project, runId: "escaped-import", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const quotedProjectRoot = path.join(project, 'checkout"quoted');
  fs.mkdirSync(quotedProjectRoot);
  const compiled = compileSmithersWorkflow({
    projectRoot: quotedProjectRoot,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-escaped-import",
    renderedPrompts: plan.value!.rendered_prompts
  });

  let importPath = path
    .relative(path.dirname(compiled.evidenceWorkflowPath), compiled.workflowPath)
    .split(path.sep)
    .join("/");
  if (!importPath.startsWith(".")) {
    importPath = `./${importPath}`;
  }
  importPath = importPath.replace(/\.tsx$/u, "");
  const evidenceSource = fs.readFileSync(compiled.evidenceWorkflowPath, "utf8");
  assert.ok(evidenceSource.includes(`from ${JSON.stringify(importPath)};`), evidenceSource);
});

test("compileSmithersWorkflow applies group execution defaults", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
groups:
  setup:
    label: Setup
    defaults:
      timeout_seconds: 1200
      max_attempts: 2
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    prompt: setup/project-discovery.md
    group: setup
    depends_on:
      - __start__
    outputs:
      - path: setup/project-discovery.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );

  const plan = await planRun({ projectRoot: project, runId: "group-timeout", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-group-timeout",
    renderedPrompts: plan.value!.rendered_prompts
  });

  const smithersTasks = JSON.parse(fs.readFileSync(compiled.tasksPath, "utf8")) as {
    tasks: Array<{
      attemptId: string;
      timeoutMs: number;
      heartbeatTimeoutMs: number;
      retries: number;
      metadata?: {
        retryPolicy?: { maxAttempts?: number; smithersRetries?: number };
        timeout?: { seconds?: number; heartbeatTimeoutMs?: number };
      };
    }>;
  };
  const task = smithersTasks.tasks.find((entry) => entry.attemptId === "project-discovery");
  assert.equal(task?.timeoutMs, 1_200_000);
  assert.equal(task?.heartbeatTimeoutMs, 1_200_000);
  assert.equal(task?.retries, 1);
  assert.equal(task?.metadata?.retryPolicy?.maxAttempts, 2);
  assert.equal(task?.metadata?.retryPolicy?.smithersRetries, 1);
  assert.equal(task?.metadata?.timeout?.seconds, 1200);
  assert.equal(task?.metadata?.timeout?.heartbeatTimeoutMs, 1_200_000);
  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  const expectedRuntimeContext = [
    "## Topology Runtime Context",
    "",
    "- Timeout: 1200 seconds total.",
    "- Finalization reserve: 200 seconds.",
    "- Working budget before finalization: 1000 seconds.",
    "- Stop starting new delegated or tool work when the finalization reserve begins.",
    "- During the reserve, write and validate every required artifact, marking unfinished work blocked instead of omitting outputs."
  ].join("\n");
  assert.equal(
    workflowSource.includes(`"runtimeContext": ${JSON.stringify(expectedRuntimeContext)}`),
    true,
    workflowSource
  );
  assert.match(workflowSource, /\$\{task\.runtimeContext\}\\n\\n\$\{operatorPrompt\}/u);
});

test("topology runtime context keeps a bounded finalization reserve", async () => {
  const { topologyRuntimeContextForTimeout } = await import("../src/smithers.js");
  const cases = [
    { timeoutMs: 1_000, timeoutSeconds: 1, reserveSeconds: 1, workingSeconds: 0 },
    { timeoutMs: 2_000, timeoutSeconds: 2, reserveSeconds: 1, workingSeconds: 1 },
    { timeoutMs: 12_000, timeoutSeconds: 12, reserveSeconds: 2, workingSeconds: 10 },
    { timeoutMs: 7_200_000, timeoutSeconds: 7200, reserveSeconds: 300, workingSeconds: 6900 }
  ];
  for (const entry of cases) {
    const context = topologyRuntimeContextForTimeout(entry.timeoutMs);
    assert.match(context, new RegExp(`- Timeout: ${entry.timeoutSeconds} seconds total\\.`, "u"));
    assert.match(context, new RegExp(`- Finalization reserve: ${entry.reserveSeconds} seconds\\.`, "u"));
    assert.match(context, new RegExp(`- Working budget before finalization: ${entry.workingSeconds} seconds\\.`, "u"));
    if (entry.timeoutSeconds > 1) {
      assert.ok(entry.workingSeconds > 0);
    }
  }
});

test("startRun --agent does not carry the previous agent's model onto the new agent", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  // The default profile is CodexAgent/gpt-5.5/xhigh; switching only the agent
  // must not hand Codex's model and reasoning to Claude.
  const run = await startRun({
    projectRoot: project,
    runId: "agent-switch",
    agent: "ClaudeAgent",
    env: fakeSmithersEnv(project)
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const smithersTasks = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "tasks.json"), "utf8")
  ) as { tasks: Array<{ agentRef?: string; modelName?: string | null; reasoningEffort?: string | null }> };
  assert.equal(smithersTasks.tasks[0]?.agentRef, "ClaudeAgent");
  assert.equal(smithersTasks.tasks[0]?.modelName ?? null, null);
  assert.equal(smithersTasks.tasks[0]?.reasoningEffort ?? null, null);

  // An explicit --model still pins the model for the overridden agent.
  const pinned = await startRun({
    projectRoot: project,
    runId: "agent-switch-pinned",
    agent: "ClaudeAgent",
    model: "claude-sonnet-5",
    env: fakeSmithersEnv(project)
  });
  assert.equal(pinned.ok, true, JSON.stringify(pinned.diagnostics));
  const pinnedTasks = JSON.parse(
    fs.readFileSync(path.join(pinned.value!.run_root, "smithers", "tasks.json"), "utf8")
  ) as { tasks: Array<{ agentRef?: string; modelName?: string | null; reasoningEffort?: string | null }> };
  assert.equal(pinnedTasks.tasks[0]?.agentRef, "ClaudeAgent");
  assert.equal(pinnedTasks.tasks[0]?.modelName, "claude-sonnet-5");
  assert.equal(pinnedTasks.tasks[0]?.reasoningEffort ?? null, null);
});

test("init reports an agent registry that does not export a generated agent", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });

  // Simulate a project scaffolded before ClaudeAgent, DeepSeekAgent, and KimiAgent
  // existed: the registry predates the adapters, and init preserves project-owned files.
  const registryPath = path.join(project, ".smithers/agents/index.ts");
  fs.writeFileSync(
    registryPath,
    'import { createCodexAgent } from "./codex";\n' +
      'export { createCodexAgent } from "./codex";\n' +
      "export const agentFactories = { CodexAgent: createCodexAgent };\n",
    "utf8"
  );

  const upgraded = initProject({ projectRoot: project });
  assert.equal(upgraded.ok, true);
  const stale = upgraded.diagnostics.filter((entry) => entry.code === "INIT_AGENT_REGISTRY_STALE");
  assert.equal(stale.length, 3, JSON.stringify(upgraded.diagnostics));
  assert.equal(stale[0]?.severity, "warning");
  assert.match(stale.map((entry) => entry.message).join("\n"), /ClaudeAgent/);
  assert.match(stale.map((entry) => entry.message).join("\n"), /DeepSeekAgent/);
  assert.match(stale.map((entry) => entry.message).join("\n"), /KimiAgent/);

  // A registry that names Claude, DeepSeek, and Kimi without registering their
  // factories is still stale: nothing resolves it, since generated adapters export
  // only factories.
  fs.writeFileSync(
    registryPath,
    'import { createCodexAgent } from "./codex";\n' +
      'export { CodexAgent, createCodexAgent } from "./codex";\n' +
      'export { ClaudeAgent } from "./claude";\n' +
      "export const agentFactories = { CodexAgent: createCodexAgent };\n",
    "utf8"
  );
  const named = initProject({ projectRoot: project });
  const namedStale = named.diagnostics.filter((entry) => entry.code === "INIT_AGENT_REGISTRY_STALE");
  assert.equal(namedStale.length, 3, JSON.stringify(named.diagnostics));
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /ClaudeAgent/);
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /DeepSeekAgent/);
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /KimiAgent/);

  // A registry that exports every generated agent stays quiet.
  const regenerated = initProject({ projectRoot: project, force: true });
  assert.equal(
    regenerated.diagnostics.filter((entry) => entry.code === "INIT_AGENT_REGISTRY_STALE").length,
    0,
    JSON.stringify(regenerated.diagnostics)
  );
});

test("startRun compiles normal Smithers tasks, persists provenance, and submits through Smithers CLI", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs.readFileSync(configPath, "utf8").replace('reasoning = "xhigh"', 'reasoning = "max"'),
    "utf8"
  );

  const run = await startRun({
    projectRoot: project,
    runId: "smithers-run",
    env: fakeSmithersEnv(project),
    model: "gpt-runtime-override",
    maxConcurrency: 2,
    prompt: "Operator priority",
    workflowInput: { issue: 2 }
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(run.value?.status, "running");
  assert.deepEqual(run.value!.workflow_ids, ["ultrafuzz-smithers-run"]);

  const list = await listRuns({ projectRoot: project, env: fakeSmithersEnv(project) });
  assert.equal(list.value?.product_runs.length, 1);
  assert.equal(list.value?.runs[0]?.workflow_run_id, "ultrafuzz-smithers-run");
  const status = await getRunStatus({ projectRoot: project, runId: run.value!.run_id, env: fakeSmithersEnv(project) });
  assert.equal(status.value?.status, "running");
  assert.equal(status.value?.metadata?.workflow_ids instanceof Array, true);
  assert.equal(status.value?.workflow?.run_id, "ultrafuzz-smithers-run");
  assert.equal(status.value?.workflow?.inspect.ok, true);
  assert.equal(status.value?.workflow?.events.ok, true);

  const smithersTasks = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "tasks.json"), "utf8")
  ) as {
    tasks: Array<{
      agentRef?: string;
      modelName?: string;
      reasoningEffort?: string;
      timeoutMs?: number;
      retries?: number;
      retryPolicy?: unknown;
      workspacePath?: string;
      workspaceOutputRoots?: string[];
      baseCommit?: string;
      artifactDir?: string;
      metadata?: {
        node?: { concreteNodeId?: string };
        model?: { modelName?: string; reasoningEffort?: string };
        workspace?: { baseCommit?: string };
      };
    }>;
  };
  const smithersInput = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "input.json"), "utf8")
  ) as {
    operator_prompt?: string;
    operator_input?: { issue?: number };
    tasks?: Array<{ prompt?: string; prompt_path?: string }>;
  };
  assert.equal(smithersInput.operator_prompt, "Operator priority");
  assert.equal(smithersInput.operator_input?.issue, 2);
  assert.equal(smithersInput.tasks?.[0]?.prompt, undefined);
  assert.equal(typeof smithersInput.tasks?.[0]?.prompt_path, "string");
  assert.equal(smithersTasks.tasks[0]?.agentRef, "CodexAgent");
  assert.equal(smithersTasks.tasks[0]?.modelName, "gpt-runtime-override");
  assert.equal(smithersTasks.tasks[0]?.reasoningEffort, "max");
  const expectedBaseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: project,
    encoding: "utf8"
  }).trim();
  assert.equal(smithersTasks.tasks[0]?.baseCommit, expectedBaseCommit);
  assert.equal(smithersTasks.tasks[0]?.metadata?.workspace?.baseCommit, expectedBaseCommit);
  assert.equal(smithersTasks.tasks[0]?.artifactDir, path.join(run.value!.run_root, "artifacts", "project-discovery"));
  assert.notEqual(smithersTasks.tasks[0]?.artifactDir, smithersTasks.tasks[0]?.workspacePath);
  assert.deepEqual(smithersTasks.tasks[0]?.workspaceOutputRoots, ["artifacts/project-discovery"]);
  assert.ok(smithersTasks.tasks.every((task) => typeof task.timeoutMs === "number"));
  assert.ok(smithersTasks.tasks.every((task) => typeof task.retries === "number"));
  assert.ok(smithersTasks.tasks.every((task) => task.retryPolicy !== null));
  assert.equal(smithersTasks.tasks[0]?.metadata?.node?.concreteNodeId, "project-discovery");
  assert.equal(smithersTasks.tasks[0]?.metadata?.model?.modelName, "gpt-runtime-override");
  assert.equal(smithersTasks.tasks[0]?.metadata?.model?.reasoningEffort, "max");

  const workflowSource = fs.readFileSync(
    path.join(project, ".smithers", "workflows", "ultrafuzz-smithers-run.tsx"),
    "utf8"
  );
  const expectedArtifactDir = path.join(run.value!.run_root, "artifacts", "project-discovery");
  assert.match(workflowSource, /smithers-orchestrator/);
  // Explicit index path: a sibling .smithers/agents.ts scaffolded by Smithers
  // would otherwise shadow the .smithers/agents/ directory under bun.
  assert.match(workflowSource, /import \* as projectAgents from "\.\.\/agents\/index\.ts";/);
  assert.doesNotMatch(workflowSource, /import \* as projectAgents from "\.\.\/agents";/);
  assert.match(workflowSource, /agent=\{agentForTask\(task\)\}/);
  assert.match(workflowSource, /addDir:\s*\[task\.artifactDir, \.\.\.task\.dependencyArtifactDirs\]/);
  assert.match(workflowSource, /materializePromptSchemas\(path\.join\(workspaceRoot, "\.ultrafuzz", "schemas"\)\)/);
  assert.match(workflowSource, /prompt\.replaceAll\(task\.artifactDir, mirroredArtifactDir\(task\)\)/);
  assert.match(workflowSource, /path\.join\(task\.workspacePath, "artifacts", task\.attemptId\)/);
  assert.match(workflowSource, /taskArtifactRoots\(task, artifactDir\)/);
  assert.match(workflowSource, /lstatSync\(candidate\)/);
  assert.match(workflowSource, /function isMissingPathError/);
  assert.match(workflowSource, /function prepareArtifactMirror/);
  assert.match(workflowSource, /assertWorkspaceBaseCommit\(task\.workspacePath, task\.baseCommit\)/);
  assert.match(workflowSource, /assertAgentWorkspaceTreeProvenance/);
  assert.match(workflowSource, /typeof args\?\.rootDir === "string"/);
  assert.match(workflowSource, /taskWorkspaceOutputRoots\(task\)\s*\n\s*\);/);
  assert.match(workflowSource, /function taskTestOutputRelativeRoots/);
  assert.match(workflowSource, /task\.workspaceOutputRoots\.filter/);
  assert.match(workflowSource, /function prepareTaskWorkspaceOutputRoots/);
  assert.match(workflowSource, /function prepareAnchoredDirectory/);
  assert.match(workflowSource, /cleanWorkspaceOutputRootsForRetry\(workspaceRoot, testOutputRoots\)/);
  assert.match(workflowSource, /persistLegacyWorkspaceSourceClaim\(\{/);
  assert.match(
    workflowSource,
    /await postflight\("artifact-preparation-postflight",[\s\S]*?prepareTaskWorkspaceOutputRoots\(task, \{ replayWorkspacePatches: false \}\)[\s\S]*?workspace-patch-materialization-postflight[\s\S]*?const verifiedWorkspace = await postflight\("workspace-provenance-postflight",[\s\S]*?assertAgentWorkspaceTreeProvenance\([\s\S]*?await postflight\("source-attestation-persistence-postflight",[\s\S]*?persistLegacyWorkspaceSourceClaim\(\{[\s\S]*?workspace: verifiedWorkspace/
  );
  assert.match(workflowSource, /\(\) => agent\.generate\(args\)/);
  assert.doesNotMatch(workflowSource, /writeWorkspaceSourceAttestation/);
  assert.doesNotMatch(workflowSource, /persistWorkspaceSourceAttestation\(\{/);
  assert.match(workflowSource, /readLegacyWorkspaceSourceClaim\(\{/);
  assert.match(workflowSource, /sourceAttestationClosure\(task\)/);
  assert.doesNotMatch(workflowSource, /agentWorkspaceAttestations/);
  assert.match(workflowSource, /function sourceClaim/);
  assert.match(workflowSource, /delete runMetadata\.source_attestation/);
  assert.match(workflowSource, /sourceClaim\(task\);/);
  assert.doesNotMatch(workflowSource, /verifyReportSourceAttestation/);
  assert.match(workflowSource, /baseBranch=\{task\.baseCommit\}/);
  assert.match(workflowSource, /base_commit: task\.baseCommit/);
  assert.equal(workflowSource.includes(`"baseCommit": ${JSON.stringify(expectedBaseCommit)}`), true);
  assert.match(workflowSource, /\{\(\) => prepareTask\(task\)\}/);
  assert.match(workflowSource, /runMetadata\.target_revision = targetRevision/);
  assert.match(workflowSource, /function assertTaskInputs/);
  assert.match(workflowSource, /artifact handoff directory is unavailable/);
  assert.match(workflowSource, /function canonicalEmptyArtifact/);
  assert.match(workflowSource, /output\.primary && output\.contract !== "ultrafuzz\/findings@1"/);
  assert.match(workflowSource, /artifactContractDefinition\(output\.contract\)\.validEmptyExample/);
  assert.match(workflowSource, /function artifactAwareAgent/);
  assert.match(workflowSource, /const result = await runAgentWithPostflight\(/);
  assert.match(workflowSource, /\(\) => agent\.generate\(args\)/);
  assert.match(
    workflowSource,
    /await postflight\("artifact-preparation-postflight",[\s\S]*?prepareTaskWorkspaceOutputRoots\(task, \{ replayWorkspacePatches: false \}\)/
  );
  assert.match(workflowSource, /materializeMissingMarkdownArtifacts\(task, result\)/);
  assert.match(workflowSource, /normalizeLegacyFindingFields\(task\)/);
  assert.match(workflowSource, /normalizeLegacyReportProvenance\(task\)/);
  assert.match(workflowSource, /normalizeLegacyGeneratedTestManifests\(task\)/);
  assert.match(workflowSource, /materializeGeneratedTestCompanions\(task\)/);
  assert.match(workflowSource, /materializeWorkspacePatch\(task\)/);
  assert.match(workflowSource, /const sourceCandidates = INVARIANT_TEST_ROOT_NAMES\.flatMap\(\(testRoot\) => \[/);
  assert.match(workflowSource, /path\.resolve\(workspaceRoot, testRoot, "foundry", workspaceRelativePath\)/);
  assert.match(
    workflowSource,
    /path\.resolve\(workspaceRoot, testRoot, "foundry", logicalNodeId, workspaceRelativePath\)/
  );
  assert.match(workflowSource, /typeof entry === "string" \? \{ path: entry \} : entry/);
  assert.match(workflowSource, /typeof finding\.confidence === "number"/);
  assert.match(workflowSource, /finding\.confidence = String\(finding\.confidence\)/);
  assert.match(workflowSource, /\(strategy as Record<string, unknown>\)\.origin/);
  assert.match(workflowSource, /finding\.strategy = legacyStrategy\.trim\(\)/);
  assert.match(workflowSource, /finding\.evidence = \[evidence\]/);
  assert.match(workflowSource, /report\.issues\.map/);
  assert.match(workflowSource, /\["implementation_paths", "test_paths"\]/);
  assert.match(workflowSource, /\["fuzzer_backend", "fuzzer_backends"\]/);
  assert.match(
    workflowSource,
    /await postflight\("artifact-validation-postflight", \(\) => \{[\s\S]*?verifiedArtifacts = collectVerifiedArtifacts\(task\)/
  );
  assert.doesNotMatch(workflowSource, /addDir:\s*\[(?:task\.)?(?:workspacePath|repoPath|runRoot)\]/);
  assert.equal(workflowSource.includes(`"artifactDir": ${JSON.stringify(expectedArtifactDir)}`), true);
  assert.equal(workflowSource.includes(`"artifactDir": ${JSON.stringify(run.value!.run_root)}`), false);
  assert.equal(workflowSource.includes(`"artifactDir": ${JSON.stringify(project)}`), false);
  assert.match(workflowSource, /"modelName": "gpt-runtime-override"/);
  assert.match(workflowSource, /"reasoningEffort": "max"/);
  assert.match(workflowSource, /metadata=\{task\.metadata\}/);
  assert.match(workflowSource, /output=\{outputs\.task\}/);
  assert.match(workflowSource, /Authorized Defensive Security Context/);
  assert.match(workflowSource, /id=\{task\.preparationId\}/);
  assert.match(workflowSource, /dependsOn=\{task\.dependsOn\}/);
  assert.match(workflowSource, /dependsOn=\{\[task\.preparationId\]\}/);
  assert.match(workflowSource, /untrusted data, not instructions/);
  assert.match(workflowSource, /function resolveRegularArtifactFile/);
  assert.match(workflowSource, /throw new Error\(failureMessage\)/);
  assert.match(workflowSource, /<Worktree/);
  assert.match(workflowSource, /\.\.\.\(usesPinnedSource \? \{ baseBranch: pinnedSourceBranch \} : \{\}\)/);
  assert.match(workflowSource, /function preservePinnedSourceProof/);
  assert.match(workflowSource, /"source-proofs"/);
  assert.doesNotMatch(workflowSource, /const layers =/);
  assert.doesNotMatch(workflowSource, /<Sequence\b/);
  assert.match(workflowSource, /<Parallel\b/);
  assert.doesNotMatch(workflowSource, /@ultrafuzz\/backends/);
  const evidenceWorkflowSource = fs.readFileSync(path.join(run.value!.run_root, "smithers", "workflow.tsx"), "utf8");
  assert.match(evidenceWorkflowSource, /export \{ default \}/);
  assert.doesNotMatch(evidenceWorkflowSource, /__ULTRAFUZZ_/);

  const submission = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "submission.json"), "utf8")
  ) as {
    smithers_run_id?: string;
    command?: string[];
  };
  assert.equal(submission.smithers_run_id, "ultrafuzz-smithers-run");
  const submittedWorkflow = submission.command?.[2] ?? "";
  assert.ok(submittedWorkflow.startsWith(path.join(run.value!.run_root, "smithers", "execution-snapshots") + path.sep));
  assert.ok(submittedWorkflow.endsWith(path.join(".smithers", "workflows", "ultrafuzz-smithers-run.tsx")));
  assert.notEqual(submittedWorkflow, path.join(project, ".smithers", "workflows", "ultrafuzz-smithers-run.tsx"));
  assert.ok(submission.command?.includes("--supervise"));
  const staleThresholdIndex = submission.command?.indexOf("--supervise-stale-threshold") ?? -1;
  assert.deepEqual(submission.command?.slice(staleThresholdIndex, staleThresholdIndex + 4), [
    "--supervise-stale-threshold",
    "30s",
    "--supervise-max-concurrent",
    "1"
  ]);
  const durableState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as RunState;
  assert.equal(durableState.workflow_deadline_at !== undefined, true);
  assert.equal(durableState.concurrency.requested_concurrency, 2);
  assert.equal(durableState.controller_lease.status, "active");
});

test("getRunHealth adapts the workflow health summary to the Ultrafuzz run", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "health-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const health = await getRunHealth({ projectRoot: project, runId: "health-run", windowMinutes: 5, env });

  assert.equal(health.ok, true, JSON.stringify(health.diagnostics));
  assert.equal(health.value?.run_id, "health-run");
  assert.equal(health.value?.workflow_run_id, "ultrafuzz-health-run");
  assert.equal(health.value?.verdict, "running-healthy");
  assert.equal(health.value?.counts.in_progress, 1);
  assert.equal(health.value?.model_mix[0]?.quota_parked, false);
  assert.equal(health.value?.gating[0]?.node_id, "project-discovery");
  assert.doesNotMatch(JSON.stringify(health.value), /smithers/iu);
  assert.match(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /status ultrafuzz-health-run --window 5/);
});

test("pauseRun accepts the workflow runner pause-request exit and is idempotent once paused", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "pause-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const baselineSnapshots = workflowExecutionSnapshotCount(run.value!.run_root);

  const requested = await pauseRun({ projectRoot: project, runId: "pause-run", env });
  assert.equal(requested.ok, true, JSON.stringify(requested.diagnostics));
  assert.equal(requested.value?.status, "pause-requested");
  assert.equal(requested.value?.submitted, true);
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots);

  env.SMITHERS_FAKE_ALREADY_PAUSED = "1";
  const paused = await pauseRun({ projectRoot: project, runId: "pause-run", env });
  assert.equal(paused.ok, true, JSON.stringify(paused.diagnostics));
  assert.equal(paused.value?.status, "paused");
  assert.equal(paused.value?.submitted, false);
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots);
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    status: string;
  };
  assert.equal(state.status, "paused");
  assert.match(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /pause ultrafuzz-pause-run --format json/);
});

test("pauseRun requires explicit workflow confirmation before persisting paused state", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "pause-empty", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  env.SMITHERS_FAKE_PAUSE_EMPTY_SUCCESS = "1";
  const requested = await pauseRun({ projectRoot: project, runId: "pause-empty", env });

  assert.equal(requested.ok, true, JSON.stringify(requested.diagnostics));
  assert.equal(requested.value?.status, "pause-requested");
  assert.equal(requested.value?.submitted, true);
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    status: string;
  };
  assert.equal(state.status, "running");
});

test("pause and cancel reject conflicting run IDs available in multiline responses", async () => {
  for (const action of ["pause", "cancel"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `${action}-conflicting-response`;
    const workflowRunId = `ultrafuzz-${runId}`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({ workflowRunId, status: "running", state: "running", steps: [] }),
      ...(action === "pause"
        ? {
            pauseStatus: "paused" as const,
            pauseOutput: '{"status":"paused"}\n{"run":{"id":"different-workflow-run"}}'
          }
        : {
            cancelStatus: "cancelled" as const,
            cancelOutput: '{"status":"cancelled"}\n{"workflowRunId":"different-workflow-run"}'
          })
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, `${action}: ${JSON.stringify(run.diagnostics)}`);

    const result =
      action === "pause"
        ? await pauseRun({ projectRoot: project, runId, env })
        : await cancelRun({ projectRoot: project, runId, env });

    assert.equal(result.ok, false, action);
    assert.equal(result.diagnostics[0]?.code, action === "pause" ? "WORKFLOW_PAUSE_FAILED" : "WORKFLOW_CANCEL_FAILED");
    assert.match(result.diagnostics[0]?.message ?? "", /conflicting workflow run identity/u, action);
  }
});

test("workflow synchronization preserves the paused run state", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const launchEnv = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "paused-sync", env: launchEnv });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-paused-sync",
      status: "paused",
      state: "paused",
      steps: [{ id: "node:project-discovery", state: "pending" }]
    })
  });

  const status = await getRunStatus({ projectRoot: project, runId: "paused-sync", env });

  assert.equal(status.ok, true, JSON.stringify(status.diagnostics));
  assert.equal(status.value?.status, "paused");
  assert.equal(status.value?.workflow?.status, "paused");
});

test("workflow synchronization preserves a quota-waiting run with parked tasks", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const launchEnv = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "quota-waiting-sync", env: launchEnv });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-quota-waiting-sync",
      status: "waiting-quota",
      state: "waiting-quota",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    })
  });

  const status = await getRunStatus({ projectRoot: project, runId: "quota-waiting-sync", env });

  assert.equal(status.ok, true, JSON.stringify(status.diagnostics));
  assert.equal(status.value?.status, "running");
  assert.equal(status.value?.workflow?.status, "waiting-quota");
});

test("startRun maps keep_workspaces to the Smithers worktree retention environment", async () => {
  for (const keepWorkspaces of [false, true]) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    if (keepWorkspaces) {
      const configPath = path.join(project, "ultrafuzz.toml");
      fs.writeFileSync(
        configPath,
        fs.readFileSync(configPath, "utf8").replace("keep_workspaces = false", "keep_workspaces = true"),
        "utf8"
      );
    }
    const keepLog = path.join(project, "keep-worktrees.log");
    const env = {
      ...fakeSmithersEnv(project),
      SMITHERS_KEEP_WORKTREES: "1",
      SMITHERS_FAKE_KEEP_WORKTREES_LOG: keepLog
    };

    const run = await startRun({ projectRoot: project, runId: `keep-workspaces-${keepWorkspaces}`, env });

    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    assert.equal(fs.readFileSync(keepLog, "utf8"), keepWorkspaces ? "1\n" : "\n");
  }
});

test("startRun injects the configured Forge guard into the workflow environment and metadata", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const binDir = path.dirname(env.SMITHERS_BIN!);
  const realForge = path.join(binDir, "forge");
  fs.writeFileSync(realForge, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(realForge, 0o755);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace("forge_vmem_limit_kb = 12582912", "forge_vmem_limit_kb = 16777216")
      .replace("forge_rayon_threads = 1", "forge_rayon_threads = 2"),
    "utf8"
  );
  const guardLog = path.join(project, "forge-guard.log");
  env.SMITHERS_FAKE_FORGE_GUARD_LOG = guardLog;

  const run = await startRun({ projectRoot: project, runId: "forge-guard", env });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const wrapper = path.join(run.value!.run_root, "safe-bin", "forge");
  assert.equal(fs.readFileSync(guardLog, "utf8"), `${wrapper}\n`);
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o700);
  assert.match(
    fs.readFileSync(path.join(run.value!.run_root, "config.resolved.toml"), "utf8"),
    /forge_vmem_limit_kb = 16777216/u
  );
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    forge_guard?: Record<string, unknown>;
  };
  assert.deepEqual(metadata.forge_guard, {
    enabled: true,
    active: true,
    virtual_memory_limit_kb: 16_777_216,
    rayon_threads: 2
  });
});

test("startRun forwards configured and explicitly allowed environment variables only", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const environmentLog = path.join(project, "smithers-environment.log");
  const contextLog = path.join(project, "smithers-context.log");
  const env = {
    ...fakeSmithersEnv(project),
    SMITHERS_FAKE_ENV_LOG: environmentLog,
    SMITHERS_FAKE_CONTEXT_LOG: contextLog,
    SMITHERS_RUN_ID: "outer-run",
    SMITHERS_NODE_ID: "outer-node",
    SMITHERS_ATTEMPT: "3",
    SMITHERS_ITERATION: "2",
    SMITHERS_CLI_SRC_DIR: "/outer/cli/src",
    SMITHERS_SNAPSHOT_SOCK: "/outer/snapshot.sock",
    OPENAI_API_KEY: "configured-agent-key",
    AWS_SECRET_ACCESS_KEY: "unrelated-host-key",
    FOUNDRY_PROFILE: "ci",
    ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "FOUNDRY_PROFILE"
  };

  const run = await startRun({ projectRoot: project, runId: "filtered-environment", env });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(environmentLog, "utf8"), "configured-agent-key||ci\n");
  assert.equal(fs.readFileSync(contextLog, "utf8"), "|||||\n");
});

test("startRun forwards cloud provider credentials through the Smithers environment filter", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    `${fs
      .readFileSync(configPath, "utf8")
      .replace('[execution]\nmode = "local"', '[execution]\nmode = "cloud"\nprovider = "modal"')}

[execution.providers.modal]
app = "ultrafuzz-test"
image = "ultrafuzz-test"
credential_env = ["UFZ_PROVIDER_ONE", "UFZ_PROVIDER_TWO"]
`,
    "utf8"
  );
  const cloudEnvironmentLog = path.join(project, "smithers-cloud-environment.log");
  const env = {
    ...fakeSmithersEnv(project),
    SMITHERS_FAKE_CLOUD_ENV_LOG: cloudEnvironmentLog,
    OPENAI_API_KEY: "configured-agent-key",
    UFZ_PROVIDER_ONE: "provider-one",
    UFZ_PROVIDER_TWO: "provider-two"
  };

  const run = await startRun({ projectRoot: project, runId: "cloud-environment", env });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(cloudEnvironmentLog, "utf8"), "provider-one|provider-two\n");
});

test("startRun forwards Kimi-specific runtime environment without exposing unrelated secrets", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const kimiEnvironmentLog = path.join(project, "smithers-kimi-environment.log");
  const env = {
    ...fakeSmithersEnv(project),
    SMITHERS_FAKE_KIMI_ENV_LOG: kimiEnvironmentLog,
    KIMI_BASE_URL: "https://kimi.example.invalid/v1",
    ULTRAFUZZ_KIMI_SHARED_AUTH_HOME: "/data/run/kimi-code-auth",
    ULTRAFUZZ_KIMI_SESSION_HOME: "/data/run/kimi-code-sessions",
    ULTRAFUZZ_MODAL_REMOTE_ROOT: "/data/run",
    AWS_SECRET_ACCESS_KEY: "unrelated-host-key"
  };

  const run = await startRun({ projectRoot: project, runId: "kimi-subscription-environment", agent: "KimiAgent", env });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(
    fs.readFileSync(kimiEnvironmentLog, "utf8"),
    "||https://kimi.example.invalid/v1|/data/run/kimi-code-auth|/data/run/kimi-code-sessions|/data/run\n"
  );
});

test("startRun forwards persistent subscription paths only for a subscription agent", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const environmentLog = path.join(project, "smithers-persistent-auth-environment.log");
  const env = {
    ...fakeSmithersEnv(project),
    SMITHERS_FAKE_PERSISTENT_AUTH_ENV_LOG: environmentLog,
    ULTRAFUZZ_PERSISTENT_SUBSCRIPTION_AUTH_PATH:
      "/__modal/volumes/vo-test/run/subscription-auth/anthropic/.credentials.json",
    ULTRAFUZZ_MODAL_REMOTE_ROOT: "/data/run",
    AWS_SECRET_ACCESS_KEY: "unrelated-host-key"
  };

  const run = await startRun({ projectRoot: project, runId: "persistent-auth-environment", agent: "ClaudeAgent", env });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(
    fs.readFileSync(environmentLog, "utf8"),
    "/__modal/volumes/vo-test/run/subscription-auth/anthropic/.credentials.json|/data/run|\n"
  );
});

test("startRun forwards only the configured DeepSeek API key for DeepSeek runs", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const deepSeekEnvironmentLog = path.join(project, "smithers-deepseek-environment.log");

  const run = await startRun({
    projectRoot: project,
    runId: "deepseek-api-environment",
    agent: "DeepSeekAgent",
    env: {
      ...fakeSmithersEnv(project),
      SMITHERS_FAKE_DEEPSEEK_ENV_LOG: deepSeekEnvironmentLog,
      DEEPSEEK_API_KEY: "deepseek-agent-key",
      ANTHROPIC_API_KEY: "unrelated-anthropic-key"
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(deepSeekEnvironmentLog, "utf8"), "deepseek-agent-key|\n");
});

test("startRun forwards Moonshot fallback credentials for Kimi API-key auth", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace(
        '[agents.KimiAgent]\nauth = "subscription"',
        '[agents.KimiAgent]\nauth = "api-key"\napi_key_env = "KIMI_API_KEY"'
      ),
    "utf8"
  );
  const kimiEnvironmentLog = path.join(project, "smithers-kimi-api-environment.log");

  const run = await startRun({
    projectRoot: project,
    runId: "kimi-api-environment",
    agent: "KimiAgent",
    env: {
      ...fakeSmithersEnv(project),
      SMITHERS_FAKE_KIMI_ENV_LOG: kimiEnvironmentLog,
      MOONSHOT_API_KEY: "moonshot-fallback-key",
      KIMI_BASE_URL: "https://kimi.example.invalid/v1"
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(
    fs.readFileSync(kimiEnvironmentLog, "utf8"),
    "|moonshot-fallback-key|https://kimi.example.invalid/v1|||\n"
  );
});

test("startRun keeps operational input usable while redacting durable workflow evidence", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  const commandLog = path.join(project, "smithers-command.log");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" > "$SMITHERS_FAKE_LOG"',
      "printf '%s\\n' 'submission api_key=sk-successstdout'",
      "printf '%s\\n' 'submission token=sk-successstderr' >&2",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);

  const run = await startRun({
    projectRoot: project,
    runId: "redacted-evidence",
    prompt: "Operator token=sk-operatorsecret",
    workflowInput: { nested: { api_key: "sk-nestedsecret" }, note: "retain" },
    env: createSmithersTestEnvironment(smithers, {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: commandLog
    })
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const operationalCommand = fs.readFileSync(commandLog, "utf8");
  assert.match(operationalCommand, /sk-operatorsecret/);
  assert.match(operationalCommand, /sk-nestedsecret/);

  const inputEvidence = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "input.json"), "utf8")
  ) as {
    operator_prompt?: string;
    operator_input?: { nested?: { api_key?: string }; note?: string };
  };
  assert.equal(inputEvidence.operator_prompt, "Operator token=<redacted>");
  assert.equal(inputEvidence.operator_input?.nested?.api_key, "<redacted>");
  assert.equal(inputEvidence.operator_input?.note, "retain");

  const submissionEvidence = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "submission.json"), "utf8")
  ) as { command?: string[]; stdout?: string; stderr?: string };
  assert.equal(submissionEvidence.stdout, "submission api_key=<redacted>\n");
  assert.equal(submissionEvidence.stderr, "submission token=<redacted>\n");
  const inputArgumentIndex = submissionEvidence.command?.indexOf("--input") ?? -1;
  assert.equal(submissionEvidence.command?.[inputArgumentIndex + 1], "<redacted>");
  assert.doesNotMatch(JSON.stringify(submissionEvidence), /sk-(?:operator|nested|success)/);
});

test("startRun submits prompt paths instead of rendered prompt bodies", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const marker = "ULTRAFUZZ_LARGE_PRIVATE_PROMPT_MARKER";
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md"),
    `---
id: project-discovery
display_name: Project Discovery
---

${`${marker} `.repeat(2000)}
`,
    "utf8"
  );
  const env = fakeSmithersEnv(project);

  const run = await startRun({
    projectRoot: project,
    runId: "compact-input-run",
    env
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const commandLog = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.doesNotMatch(commandLog, new RegExp(marker));
  assert.ok(commandLog.length < 64_000, `expected compact Smithers command, got ${commandLog.length} bytes`);

  const smithersInput = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "input.json"), "utf8")
  ) as { tasks?: Array<{ prompt?: string; prompt_path?: string }> };
  assert.equal(smithersInput.tasks?.[0]?.prompt, undefined);
  const promptPath = smithersInput.tasks?.[0]?.prompt_path ?? "";
  assert.match(promptPath, /prompt\.rendered\.md$/);
  const workflowSource = fs.readFileSync(
    path.join(project, ".smithers", "workflows", "ultrafuzz-compact-input-run.tsx"),
    "utf8"
  );
  assert.match(workflowSource, /"prompt": ""/u);
  assert.ok(workflowSource.includes(`"promptPath": ${JSON.stringify(promptPath)}`));
  assert.doesNotMatch(workflowSource, new RegExp(marker, "u"));
});

test("startRun resolves the target-local Smithers binary when it is not on PATH", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const logPath = path.join(project, "local-smithers.log");
  writeFakeInstalledSmithers(project);

  const run = await startRun({
    projectRoot: project,
    runId: "local-smithers-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(logPath, "utf8"), /up .*ultrafuzz-local-smithers-run\.tsx/);
});

test("startRun patches every described runner compatibility workaround", async () => {
  const { SMITHERS_COMPATIBILITY_PATCHES } = await import("../src/smithers.js");
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const logPath = path.join(project, "patched-admission-smithers.log");
  writeFakeInstalledSmithers(project);
  const nodeModules = path.join(project, ".smithers", "node_modules");
  assert.ok(SMITHERS_COMPATIBILITY_PATCHES.length > 0, "no compatibility patches were described");
  // Seeded from the descriptions themselves, so a newly described workaround is
  // covered here without a second edit and cannot land reported-but-never-applied.
  const sources = SMITHERS_COMPATIBILITY_PATCHES.map((patch) => ({
    patch,
    source: path.join(nodeModules, ...patch.packageName.split("/"), ...patch.sourceRelativePath.split("/"))
  }));
  // Grouped by file: two workarounds can target the same source, and writing per
  // descriptor would let the second write clobber the first anchor.
  const bySource = new Map<string, string[]>();
  for (const { patch, source } of sources) {
    bySource.set(source, [...(bySource.get(source) ?? []), patch.patchable]);
  }
  for (const { patch, source } of sources) {
    const packageRoot = path.join(nodeModules, ...patch.packageName.split("/"));
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ name: patch.packageName, version: SMITHERS_ORCHESTRATOR_VERSION })}\n`,
      "utf8"
    );
  }
  for (const [source, anchors] of bySource) {
    fs.writeFileSync(source, `${anchors.join("\n")}\n`, "utf8");
  }

  const run = await startRun({
    projectRoot: project,
    runId: "patched-admission-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  for (const { patch, source } of sources) {
    // `patched` is the whole replacement text, so its presence is exactly the
    // statement "this workaround landed in the installed source".
    assert.equal(
      fs.readFileSync(source, "utf8").includes(patch.patched),
      true,
      `${patch.id} is described but was never applied to ${source}`
    );
  }
});

// The test above proves the patcher rewrites sources that carry the expected
// shape, but it supplies those sources itself, so it cannot notice upstream
// changing underneath us. This one reads the release that is actually pinned and
// asserts, per workaround, that the anchor is still unique, that upstream has not
// adopted the replacement, and that the specific upstream evidence justifying the
// workaround still holds. An anchor alone is a weak signal: `resume_hydration`
// used to anchor on a single generic line that survived a 0.31 to 0.32 refactor of
// the very ordering it depends on, which is why the ordering is asserted directly.
test("every runner compatibility patch still anchors in the pinned Smithers release", async () => {
  const { SMITHERS_COMPATIBILITY_PATCHES, SMITHERS_ENGINE_RESUME_RESET_ORDERING } = await import("../src/smithers.js");
  const resolveFromPinnedRunner = createRequire(
    fs.realpathSync(path.join(process.cwd(), "node_modules", "smithers-orchestrator", "src", "index.js"))
  );
  const sourceByPatchId = new Map<string, string>();

  assert.ok(SMITHERS_COMPATIBILITY_PATCHES.length > 0, "no compatibility patches were described");
  for (const patch of SMITHERS_COMPATIBILITY_PATCHES) {
    const label = `${patch.packageName}/${patch.sourceRelativePath}`;
    const sourceSuffix = path.join(...patch.sourceRelativePath.split("/"));
    // Each patched subpackage maps the export subpath `./<name>` onto
    // `./src/<name>.js`, so drop the `src/` prefix and the `.js` suffix. The
    // assertion below re-checks that mapping instead of trusting it.
    const exportSubpath = patch.sourceRelativePath.replace(/^src\//u, "").replace(/\.js$/u, "");
    const sourcePath = resolveFromPinnedRunner.resolve(`${patch.packageName}/${exportSubpath}`);
    assert.equal(sourcePath.endsWith(sourceSuffix), true, `${label} resolved to ${sourcePath}`);

    const packageVersion = (
      JSON.parse(fs.readFileSync(path.join(sourcePath.slice(0, -sourceSuffix.length), "package.json"), "utf8")) as {
        version?: string;
      }
    ).version;
    assert.equal(packageVersion, SMITHERS_ORCHESTRATOR_VERSION, `${label} belongs to an unpinned release`);

    const contents = fs.readFileSync(sourcePath, "utf8");
    sourceByPatchId.set(patch.id, contents);
    assert.equal(
      contents.includes(patch.patched),
      false,
      `${label} already carries Ultrafuzz's replacement; upstream may have adopted it, so drop the workaround`
    );
    assert.equal(
      contents.split(patch.patchable).length,
      2,
      `${label} no longer contains exactly one copy of the patched upstream shape; ` +
        `re-check whether Smithers ${SMITHERS_ORCHESTRATOR_VERSION} fixed this itself`
    );
    for (const absent of patch.upstreamAbsent) {
      assert.equal(
        contents.includes(absent),
        false,
        `${label} now contains ${JSON.stringify(absent)}, so Smithers ${SMITHERS_ORCHESTRATOR_VERSION} may have ` +
          `addressed this itself; re-justify or retire the ${patch.id} workaround`
      );
    }
  }

  // Ordering, not just presence: both attempt resets must still run inside the
  // deferred run-startup closure, which is what puts them ahead of the hydration the
  // anchor appends. If upstream moves a reset after the first render again, the
  // hydration would restore a node as finished and the reset would then rewrite the
  // durable row to pending, splitting session state from the database. Every marker
  // is asserted unique first, so a second occurrence elsewhere cannot let `indexOf`
  // latch onto the wrong one and hide a real inversion.
  const engineSource = sourceByPatchId.get("resume_hydration");
  assert.ok(engineSource !== undefined, "resume_hydration patch was not described");
  const uniqueIndexOf = (marker: string, label: string): number => {
    assert.equal(engineSource.split(marker).length, 2, `${label} does not occur exactly once in the pinned engine`);
    return engineSource.indexOf(marker);
  };
  const closureStart = uniqueIndexOf(SMITHERS_ENGINE_RESUME_RESET_ORDERING.closureStart, "startup closure");
  const anchor = uniqueIndexOf(SMITHERS_ENGINE_RESUME_RESET_ORDERING.anchor, "resume-hydration anchor");
  assert.ok(SMITHERS_ENGINE_RESUME_RESET_ORDERING.resetCalls.length > 0, "no resume resets were pinned");
  for (const marker of SMITHERS_ENGINE_RESUME_RESET_ORDERING.resetCalls) {
    const resetCall = uniqueIndexOf(marker, `resume reset ${JSON.stringify(marker)}`);
    assert.ok(
      closureStart < resetCall && resetCall < anchor,
      `the pinned engine no longer runs ${JSON.stringify(marker)} inside the deferred startup closure before the ` +
        "resume-hydration anchor; re-derive the anchor before trusting the resume workaround"
    );
  }

  // The Effect override only dedupes correctly while it tracks what the pinned
  // runner declares, and nothing else in the tree enforces that.
  const runnerManifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "node_modules", "smithers-orchestrator", "package.json"), "utf8")
  ) as { dependencies?: Record<string, string> };
  assert.equal(
    runnerManifest.dependencies?.effect,
    SMITHERS_EFFECT_VERSION,
    `the pinned runner declares Effect ${runnerManifest.dependencies?.effect}, but the generated manifest overrides ` +
      `Effect to ${SMITHERS_EFFECT_VERSION}`
  );
  // Every override must land on one Effect version, or the pinned set is not
  // internally consistent and npm reintroduces a second copy.
  for (const [name, version] of Object.entries(REQUIRED_SMITHERS_OVERRIDES)) {
    assert.equal(version, SMITHERS_EFFECT_VERSION, `override ${name} must track Effect ${SMITHERS_EFFECT_VERSION}`);
  }
});

test("startRun accepts the published Smithers bin target with its leading dot segment", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const logPath = path.join(project, "published-smithers.log");
  writeFakeInstalledSmithers(project, { binTarget: `./${SMITHERS_ORCHESTRATOR_BIN_PATH}` });

  const run = await startRun({
    projectRoot: project,
    runId: "published-smithers-bin-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(logPath, "utf8"), /up .*ultrafuzz-published-smithers-bin-run\.tsx/);
});

test("startRun accepts a package-manager package link and regular command shim inside node_modules", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const logPath = path.join(project, "pnpm-smithers.log");
  const paths = writeFakePnpmInstalledSmithers(project);

  const run = await startRun({
    projectRoot: project,
    runId: "pnpm-smithers-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.realpathSync(paths.packageRoot).includes(`${path.sep}.pnpm${path.sep}`), true);
  assert.match(fs.readFileSync(logPath, "utf8"), /up .*ultrafuzz-pnpm-smithers-run\.tsx/);
});

test("startRun bootstraps target-local Smithers dependencies when missing", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const installer = writeFakeNpmInstaller(project);

  const run = await startRun({
    projectRoot: project,
    runId: "bootstrap-smithers-run",
    env: {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /install .*--prefix .*\.smithers/);
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /--ignore-scripts/);
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /--package-lock=false/);
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /--registry=https:\/\/registry\.npmjs\.org/);
  assert.match(fs.readFileSync(installer.smithersLogPath, "utf8"), /up .*ultrafuzz-bootstrap-smithers-run\.tsx/);
});

test("startRun migrates the known generated Smithers caret manifest without dropping custom fields", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const packageJson = path.join(project, ".smithers", "package.json");
  fs.writeFileSync(
    packageJson,
    `${JSON.stringify(
      {
        name: "ultrafuzz-smithers",
        private: true,
        type: "module",
        scripts: { custom: "node custom.js" },
        dependencies: {
          "smithers-orchestrator": "^0.27.0",
          zod: "^4.4.3",
          "custom-agent-package": "1.2.3"
        },
        devDependencies: { typescript: "^6.0.3", "custom-build-package": "2.3.4" }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeFakeInstalledSmithers(project);
  writeFakeInstalledSmithersDependency(project, "custom-agent-package", "1.2.3");
  const logPath = path.join(project, "local-smithers.log");

  const run = await startRun({
    projectRoot: project,
    runId: "migrated-smithers-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const migrated = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
    scripts: { custom: string };
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(migrated.dependencies["smithers-orchestrator"], SMITHERS_ORCHESTRATOR_VERSION);
  assert.equal(migrated.dependencies["@moonshot-ai/kimi-code"], KIMI_CODE_VERSION);
  assert.equal(migrated.dependencies.zod, "4.4.3");
  assert.equal(migrated.devDependencies.typescript, "6.0.3");
  assert.equal(migrated.dependencies["custom-agent-package"], "1.2.3");
  assert.equal(migrated.devDependencies["custom-build-package"], "2.3.4");
  assert.equal(migrated.scripts.custom, "node custom.js");
  assert.equal((migrated as { overrides?: Record<string, string> }).overrides?.effect, SMITHERS_EFFECT_VERSION);
});

test("startRun adds the pinned Effect override to the previous generated manifest", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const packageJson = path.join(project, ".smithers", "package.json");
  const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
    overrides?: Record<string, string>;
  };
  delete manifest.overrides;
  fs.writeFileSync(packageJson, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFakeInstalledSmithers(project);

  const run = await startRun({
    projectRoot: project,
    runId: "migrated-effect-override-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: path.join(project, "local-smithers.log") }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const migrated = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
    overrides?: Record<string, string>;
  };
  assert.equal(migrated.overrides?.effect, SMITHERS_EFFECT_VERSION);
});

test("startRun migrates the previous exact Smithers manifest without dropping custom fields", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const packageJson = path.join(project, ".smithers", "package.json");
  const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  manifest.dependencies["smithers-orchestrator"] = "0.29.0";
  manifest.dependencies["custom-agent-package"] = "1.2.3";
  fs.writeFileSync(packageJson, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFakeInstalledSmithers(project, { version: "0.29.0" });
  const installer = writeFakeNpmInstaller(project);
  writeFakeInstalledSmithersDependency(project, "custom-agent-package", "1.2.3");

  const run = await startRun({
    projectRoot: project,
    runId: "migrated-exact-smithers-run",
    env: {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const migrated = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(migrated.dependencies["smithers-orchestrator"], SMITHERS_ORCHESTRATOR_VERSION);
  assert.equal(migrated.dependencies["@moonshot-ai/kimi-code"], KIMI_CODE_VERSION);
  assert.equal(migrated.dependencies["custom-agent-package"], "1.2.3");
  assert.equal((migrated as { overrides?: Record<string, string> }).overrides?.effect, SMITHERS_EFFECT_VERSION);
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /install/u);
});

// The Smithers 0.31.0 pin shipped an Effect 3 override. Its manifest must migrate
// onto the current runner and Effect 4 rather than being rejected as modified,
// because in-flight cloud runs resume against the project root they were launched
// with and would otherwise fail before the engine ever starts.
test("startRun migrates the Smithers 0.31.0 manifest and its Effect 3 override forward", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const packageJson = path.join(project, ".smithers", "package.json");
  const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
    dependencies: Record<string, string>;
    overrides?: Record<string, string>;
  };
  manifest.dependencies["smithers-orchestrator"] = "0.31.0";
  manifest.dependencies["custom-agent-package"] = "1.2.3";
  manifest.overrides = { ...manifest.overrides, effect: "3.21.4" };
  fs.writeFileSync(packageJson, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFakeInstalledSmithers(project, { version: "0.31.0" });
  const installer = writeFakeNpmInstaller(project);
  // A real install materializes an operator-declared dependency, while the fake
  // installer only writes the runner itself. Compiling a workflow package snapshots
  // its dependency closure, which requires every declared root dependency to be
  // resolvable on disk, so materialize this one the way npm would.
  const customAgentRoot = path.join(project, ".smithers", "node_modules", "custom-agent-package");
  fs.mkdirSync(customAgentRoot, { recursive: true });
  fs.writeFileSync(
    path.join(customAgentRoot, "package.json"),
    `${JSON.stringify({ name: "custom-agent-package", version: "1.2.3" })}\n`,
    "utf8"
  );

  const run = await startRun({
    projectRoot: project,
    runId: "migrated-effect-3-manifest-run",
    env: {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const migrated = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
    dependencies: Record<string, string>;
    overrides?: Record<string, string>;
  };
  assert.equal(migrated.dependencies["smithers-orchestrator"], SMITHERS_ORCHESTRATOR_VERSION);
  assert.equal(migrated.dependencies["custom-agent-package"], "1.2.3");
  assert.equal(migrated.overrides?.effect, SMITHERS_EFFECT_VERSION);
  assert.notEqual(migrated.overrides?.effect, "3.21.4");
});

test("startRun reinstalls a stale target-local Smithers package before launch", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  writeFakeInstalledSmithers(project, { version: "0.26.0" });
  const installer = writeFakeNpmInstaller(project);

  const run = await startRun({
    projectRoot: project,
    runId: "stale-smithers-run",
    env: {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /install/u);
  const installed = JSON.parse(fs.readFileSync(fakeInstalledSmithersPaths(project).packageJson, "utf8")) as {
    version: string;
  };
  assert.equal(installed.version, SMITHERS_ORCHESTRATOR_VERSION);
});

test("startRun repairs a target-local Smithers shim that points outside the pinned package", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const paths = fakeInstalledSmithersPaths(project);
  const wrongTarget = path.join(project, ".smithers", "node_modules", "wrong-smithers.js");
  fs.mkdirSync(path.dirname(wrongTarget), { recursive: true });
  fs.writeFileSync(wrongTarget, "#!/bin/sh\nexit 91\n", "utf8");
  writeFakeInstalledSmithers(project, { shimTarget: wrongTarget });
  const installer = writeFakeNpmInstaller(project);

  const run = await startRun({
    projectRoot: project,
    runId: "repaired-smithers-shim-run",
    env: {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /install/u);
  assert.equal(fs.realpathSync(paths.shim), fs.realpathSync(paths.target));
});

test("generated workflow dependencies require exact runner versions while allowing custom packages", () => {
  assert.throws(
    () =>
      assertSmithersPackageManifest({
        dependencies: {
          "smithers-orchestrator": "^0.27.0",
          zod: "4.4.3"
        },
        devDependencies: { typescript: "6.0.3" }
      }),
    /must retain Ultrafuzz's exact runner versions/u
  );
  assert.throws(
    () =>
      assertSmithersPackageManifest({
        dependencies: {
          "smithers-orchestrator": SMITHERS_ORCHESTRATOR_VERSION,
          zod: "4.4.3"
        },
        devDependencies: { typescript: "6.0.3" }
      }),
    /must retain Ultrafuzz's exact runner versions/u
  );
  // Pinning Effect itself but leaving the `@effect/*` packages layered on it
  // floating is what lets two cloud containers install different Effect trees for
  // the same run, so an incomplete override block must be rejected too.
  assert.throws(
    () =>
      assertSmithersPackageManifest({
        dependencies: {
          "@moonshot-ai/kimi-code": KIMI_CODE_VERSION,
          "smithers-orchestrator": SMITHERS_ORCHESTRATOR_VERSION,
          zod: "4.4.3"
        },
        devDependencies: { typescript: "6.0.3" },
        overrides: { effect: SMITHERS_EFFECT_VERSION }
      }),
    /must retain Ultrafuzz's exact runner versions/u
  );
  // Derived from the canonical manifest so the accepted shape cannot drift from
  // what Ultrafuzz actually generates.
  const rendered = JSON.parse(renderSmithersPackageJson()) as {
    dependencies: Record<string, string>;
    overrides: Record<string, string>;
  };
  assert.deepEqual(rendered.overrides, REQUIRED_SMITHERS_OVERRIDES);
  assert.equal(rendered.overrides.effect, SMITHERS_EFFECT_VERSION);
  // The whole `@effect/*` set must be pinned, and pinned onto the same version, or
  // npm reintroduces a second Effect copy through an unpinned caret.
  const effectOverrides = Object.entries(rendered.overrides).filter(([name]) => name.startsWith("@effect/"));
  assert.ok(effectOverrides.length > 0, "the generated manifest must pin the @effect packages alongside Effect itself");
  for (const [name, version] of effectOverrides) {
    assert.equal(version, SMITHERS_EFFECT_VERSION, `${name} must be pinned to Effect ${SMITHERS_EFFECT_VERSION}`);
  }
  assert.doesNotThrow(() =>
    assertSmithersPackageManifest({
      ...rendered,
      dependencies: { ...rendered.dependencies, "custom-agent-package": "1.2.3" }
    })
  );
});

test("startRun creates the workflow log directory before submission", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      "log_dir=''",
      'while [ "$#" -gt 0 ]; do',
      "  if [ \"$1\" = '--log-dir' ]; then",
      "    shift",
      '    log_dir="$1"',
      "  fi",
      "  shift",
      "done",
      'if [ ! -d "$log_dir" ]; then',
      "  printf '%s\\n' \"missing log dir: $log_dir\" >&2",
      "  exit 43",
      "fi",
      "printf '%s\\n' '{\"ok\":true}'",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);

  const run = await startRun({
    projectRoot: project,
    runId: "log-dir-run",
    env: createSmithersTestEnvironment(smithers, {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
    })
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.existsSync(path.join(run.value!.run_root, "smithers", "logs")), true);
});

test("submitSmithersWorkflow rejects preexisting submission evidence before invoking the runner", async () => {
  const project = tempProject();
  const smithersRoot = path.join(project, ".ultrafuzz", "runs", "preexisting-submission", "smithers");
  const submissionPath = path.join(smithersRoot, "submission.json");
  const commandLog = path.join(project, "smithers-command.log");
  const binDir = path.join(project, "fake-bin");
  const smithers = path.join(binDir, "smithers");
  fs.mkdirSync(smithersRoot, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(submissionPath, '{"unowned":true}\n', "utf8");
  fs.writeFileSync(commandLog, "", "utf8");
  fs.writeFileSync(smithers, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(commandLog)}\n`, "utf8");
  fs.chmodSync(smithers, 0o755);
  const compiled: CompiledSmithersWorkflow = {
    schemaVersion: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    runId: "preexisting-submission",
    smithersRunId: "ultrafuzz-preexisting-submission",
    workflowName: "ultrafuzz-preexisting-submission",
    tasks: [],
    projectRoot: project,
    workflowPath: path.join(project, ".smithers", "workflows", "preexisting-submission.tsx"),
    evidenceWorkflowPath: path.join(smithersRoot, "workflow.tsx"),
    expandedGraphPath: path.join(smithersRoot, "expanded-graph.json"),
    configPath: path.join(smithersRoot, "config.json"),
    inputPath: path.join(smithersRoot, "input.json"),
    tasksPath: path.join(smithersRoot, "tasks.json"),
    logsDir: path.join(smithersRoot, "logs")
  };

  await assert.rejects(
    () =>
      submitSmithersWorkflow({
        compiled,
        projectRoot: project,
        maxConcurrency: 1,
        keepWorkspaces: false,
        controllerLeaseSeconds: 30,
        env: createSmithersTestEnvironment(smithers)
      }),
    /submission evidence already exists before detached invocation/u
  );

  assert.equal(fs.readFileSync(commandLog, "utf8"), "");
  assert.equal(fs.readFileSync(submissionPath, "utf8"), '{"unowned":true}\n');
  assert.equal(fs.existsSync(compiled.logsDir), false);
});

test("submitSmithersWorkflow never overwrites submission evidence introduced during invocation", async () => {
  const project = tempProject();
  const smithersRoot = path.join(project, ".ultrafuzz", "runs", "raced-submission", "smithers");
  const submissionPath = path.join(smithersRoot, "submission.json");
  const commandLog = path.join(project, "smithers-command.log");
  const binDir = path.join(project, "fake-bin");
  const smithers = path.join(binDir, "smithers");
  fs.mkdirSync(smithersRoot, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(commandLog, "", "utf8");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"',
      "printf '%s\\n' '{\"raced\":true}' > \"$SMITHERS_FAKE_SUBMISSION\"",
      "printf '%s\\n' '{\"ok\":true}'",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  const compiled: CompiledSmithersWorkflow = {
    schemaVersion: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    runId: "raced-submission",
    smithersRunId: "ultrafuzz-raced-submission",
    workflowName: "ultrafuzz-raced-submission",
    tasks: [],
    projectRoot: project,
    workflowPath: path.join(project, ".smithers", "workflows", "raced-submission.tsx"),
    evidenceWorkflowPath: path.join(smithersRoot, "workflow.tsx"),
    expandedGraphPath: path.join(smithersRoot, "expanded-graph.json"),
    configPath: path.join(smithersRoot, "config.json"),
    inputPath: path.join(smithersRoot, "input.json"),
    tasksPath: path.join(smithersRoot, "tasks.json"),
    logsDir: path.join(smithersRoot, "logs")
  };

  await assert.rejects(
    () =>
      submitSmithersWorkflow({
        compiled,
        projectRoot: project,
        maxConcurrency: 1,
        keepWorkspaces: false,
        controllerLeaseSeconds: 30,
        env: createSmithersTestEnvironment(smithers, {
          SMITHERS_FAKE_LOG: commandLog,
          SMITHERS_FAKE_SUBMISSION: submissionPath
        })
      }),
    /submission evidence appeared during detached invocation/u
  );

  assert.match(fs.readFileSync(commandLog, "utf8"), /^up\b/u);
  assert.equal(fs.readFileSync(submissionPath, "utf8"), '{"raced":true}\n');
});

test("submitSmithersWorkflow fails closed when submission directory durability cannot be confirmed", async () => {
  const project = tempProject();
  const smithersRoot = path.join(project, ".ultrafuzz", "runs", "submission-fsync", "smithers");
  const submissionPath = path.join(smithersRoot, "submission.json");
  const commandLog = path.join(project, "smithers-command.log");
  const binDir = path.join(project, "fake-bin");
  const smithers = path.join(binDir, "smithers");
  fs.mkdirSync(smithersRoot, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(commandLog, "", "utf8");
  fs.writeFileSync(
    smithers,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$SMITHERS_FAKE_LOG"\nprintf '%s\\n' '{"ok":true}'\n`,
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  const compiled: CompiledSmithersWorkflow = {
    schemaVersion: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    runId: "submission-fsync",
    smithersRunId: "ultrafuzz-submission-fsync",
    workflowName: "ultrafuzz-submission-fsync",
    tasks: [],
    projectRoot: project,
    workflowPath: path.join(project, ".smithers", "workflows", "submission-fsync.tsx"),
    evidenceWorkflowPath: path.join(smithersRoot, "workflow.tsx"),
    expandedGraphPath: path.join(smithersRoot, "expanded-graph.json"),
    configPath: path.join(smithersRoot, "config.json"),
    inputPath: path.join(smithersRoot, "input.json"),
    tasksPath: path.join(smithersRoot, "tasks.json"),
    logsDir: path.join(smithersRoot, "logs")
  };
  const env = createSmithersTestEnvironment(smithers, { SMITHERS_FAKE_LOG: commandLog });
  const submit = () =>
    submitSmithersWorkflow({
      compiled,
      projectRoot: project,
      maxConcurrency: 1,
      keepWorkspaces: false,
      controllerLeaseSeconds: 30,
      env
    });
  const originalFsyncSync = fs.fsyncSync;
  let directoryFsyncFailed = false;
  fs.fsyncSync = ((descriptor) => {
    if (fs.fstatSync(descriptor).isDirectory()) {
      directoryFsyncFailed = true;
      const error = new Error("injected submission directory fsync failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
    return originalFsyncSync(descriptor);
  }) as typeof fs.fsyncSync;
  try {
    await assert.rejects(submit, /injected submission directory fsync failure/u);
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }

  assert.equal(directoryFsyncFailed, true);
  assert.equal(JSON.parse(fs.readFileSync(submissionPath, "utf8")).smithers_run_id, compiled.smithersRunId);
  const commandsAfterFailure = fs.readFileSync(commandLog, "utf8");
  assert.equal((commandsAfterFailure.match(/^up\b/gmu) ?? []).length, 1);
  await assert.rejects(submit, /submission evidence already exists before detached invocation/u);
  assert.equal(fs.readFileSync(commandLog, "utf8"), commandsAfterFailure);
});

test("startRun includes bounded workflow runner stdio when submission fails", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      "printf '%s\\n' 'submission stdout detail api_key=sk-stdoutsecret'",
      "printf '%s\\n' 'submission stderr detail token=sk-stderrsecret' >&2",
      "exit 42",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);

  const run = await startRun({
    projectRoot: project,
    runId: "failed-submit",
    env: createSmithersTestEnvironment(smithers, {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
    })
  });

  assert.equal(run.ok, false);
  const diagnostic = run.diagnostics.find((entry) => entry.code === "WORKFLOW_SUBMISSION_FAILED");
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /submission stdout detail/);
  assert.match(diagnostic.message, /submission stderr detail/);
  assert.doesNotMatch(diagnostic.message, /sk-(stdout|stderr)secret/);
  assert.match(diagnostic.message, /<redacted>/);
  assert.equal(diagnostic.details?.exit_code, 42);
  assert.equal(diagnostic.details?.stdout, "submission stdout detail api_key=<redacted>\n");
  assert.equal(diagnostic.details?.stderr, "submission stderr detail token=<redacted>\n");
});

test("startRun fails closed with a structured diagnostic when source HEAD is unavailable", async (context) => {
  for (const repositoryState of ["non-git", "unborn-head"] as const) {
    await context.test(repositoryState, async () => {
      const project = tempProject();
      initProject({ projectRoot: project, force: true });
      writeSmallTopology(project);
      fs.rmSync(path.join(project, ".git"), { recursive: true, force: true });
      if (repositoryState === "unborn-head") {
        execFileSync("git", ["init", "--quiet"], { cwd: project });
      }

      const run = await startRun({
        projectRoot: project,
        runId: `missing-source-${repositoryState}`
      });

      assert.equal(run.ok, false);
      assert.equal(run.value, undefined);
      assert.equal(run.diagnostics[0]?.code, "START_PREPARATION_INVALID");
      assert.equal(run.diagnostics[0]?.source, "runtime");
      assert.match(run.diagnostics[0]?.message ?? "", /could not resolve the checked-out source commit/u);
      const runRoot = path.join(project, ".ultrafuzz", "runs", `missing-source-${repositoryState}`);
      assert.deepEqual(fs.readdirSync(runRoot), []);
    });
  }
});

test("syncRun marks successful workflow completion, normalizes findings, and writes manifests", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-success";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "RunStarted" },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-success", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-success", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    status?: string;
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal((await terminalDispositionForRunRoot(run.value!.run_root)).kind, "clean");
  const findings = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "findings.json"), "utf8")
  ) as Array<{ source_node_id?: string }>;
  assert.equal(findings[0]?.source_node_id, "project-discovery");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json"), "utf8")
  ) as {
    files?: Array<{ path?: string }>;
  };
  assert.deepEqual(manifest.files?.map((entry) => entry.path).sort(), [
    "findings.json",
    "prompt.rendered.md",
    "setup/project-discovery.md"
  ]);
  const events = fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8");
  assert.match(events, /findings-normalized/);
  assert.match(events, /artifact-manifest-written/);
});

test("syncRun rejects replay when persisted receipt artifacts no longer match the manifest", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-receipt-manifest-replay";
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1, iteration: 0 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const succeeded = await syncRun({ projectRoot: project, runId, env });
  assert.equal(succeeded.value?.status, "succeeded", JSON.stringify(succeeded.diagnostics));

  const manifestPath = path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    files: Array<{ path: string; sha256: string }>;
  };
  manifest.files.find((entry) => entry.path === "setup/project-discovery.md")!.sha256 = "f".repeat(64);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const replay = await syncRun({ projectRoot: project, runId, env });

  assert.equal(replay.ok, true, JSON.stringify(replay.diagnostics));
  assert.equal(replay.value?.status, "failed");
  assert.ok(replay.diagnostics.some((diagnostic) => diagnostic.code === "VERIFIER_RECEIPT_OUTPUT_INVALID"));
  assert.equal((await terminalDispositionForRunRoot(run.value!.run_root)).kind, "operational-failure");
});

test("syncRun leaves a verifier success failed when receipt persistence fails", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-receipt-persist-failure";
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1, iteration: 0 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const layout = layoutForRunRoot(run.value!.run_root);
  fs.mkdirSync(layout.reviewDir, { recursive: true });
  fs.writeFileSync(path.join(layout.reviewDir, "verifier-receipts"), "blocked\n", "utf8");

  const sync = await syncRun({ projectRoot: project, runId, env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "NODE_SUCCESS_EVIDENCE_PERSIST_FAILED"));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as RunState;
  assert.equal(state.nodes["project-discovery"]?.status, "failed");
  assert.equal((await terminalDispositionForRunRoot(run.value!.run_root)).kind, "operational-failure");
  assert.equal(fs.readFileSync(layout.attemptLedgerPath, "utf8"), "");
});

test("syncRun leaves a verifier success failed when detached attestation persistence fails", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-attestation-persist-failure";
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1, iteration: 0 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const layout = layoutForRunRoot(run.value!.run_root);
  const artifactDir = path.join(layout.artifactsDir, "project-discovery");
  fs.mkdirSync(path.join(artifactDir, "ultrafuzz-workspace-source-attestation.json"));

  const sync = await syncRun({ projectRoot: project, runId, env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "NODE_SUCCESS_EVIDENCE_PERSIST_FAILED"));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as RunState;
  assert.equal(state.nodes["project-discovery"]?.status, "failed");
  assert.equal((await terminalDispositionForRunRoot(run.value!.run_root)).kind, "operational-failure");
  assert.equal(fs.readFileSync(layout.attemptLedgerPath, "utf8"), "");
  assert.equal(fs.readdirSync(path.join(layout.reviewDir, "verifier-receipts", "project-discovery")).length, 2);
});

test("syncRun leaves a verifier success failed on ledger append failure and resumes staged persistence idempotently", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-ledger-persist-failure";
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1, iteration: 0 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const layout = layoutForRunRoot(run.value!.run_root);
  fs.writeFileSync(layout.attemptLedgerPath, "malformed-ledger-row\n", "utf8");

  const failed = await syncRun({ projectRoot: project, runId, env });

  assert.equal(failed.ok, true, JSON.stringify(failed.diagnostics));
  assert.equal(failed.value?.status, "failed");
  assert.ok(failed.diagnostics.some((diagnostic) => diagnostic.code === "NODE_SUCCESS_EVIDENCE_PERSIST_FAILED"));
  const failedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as RunState;
  assert.equal(failedState.nodes["project-discovery"]?.status, "failed");
  assert.equal((await terminalDispositionForRunRoot(run.value!.run_root)).kind, "operational-failure");
  const attestationPath = path.join(
    layout.artifactsDir,
    "project-discovery",
    "ultrafuzz-workspace-source-attestation.json"
  );
  assert.equal(fs.existsSync(attestationPath), true);

  fs.writeFileSync(layout.attemptLedgerPath, "", "utf8");
  const recovered = await syncRun({ projectRoot: project, runId, env });

  assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
  assert.equal(recovered.value?.status, "succeeded");
  assert.equal(fs.readFileSync(layout.attemptLedgerPath, "utf8").trim().split("\n").filter(Boolean).length, 1);
  assert.equal(fs.readdirSync(path.join(layout.reviewDir, "verifier-receipts", "project-discovery")).length, 2);
});

test("syncRun marks task-output validation failures for terminal disposition", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-invalid-output";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-invalid-output", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  fs.writeFileSync(
    path.join(run.value!.run_root, "artifacts", "project-discovery", "findings.json"),
    `${JSON.stringify([{ title: "incomplete output" }])}\n`,
    "utf8"
  );

  const sync = await syncRun({ projectRoot: project, runId: "sync-invalid-output", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; provenance?: Record<string, unknown> }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.deepEqual(
    state.nodes?.["project-discovery"]?.provenance?.terminal_disposition,
    {
      schema_version: "ultrafuzz.terminal-disposition.v1",
      kind: "task-output-validation-failure"
    },
    JSON.stringify(sync.diagnostics)
  );
  assert.equal((await terminalDispositionForRunRoot(run.value!.run_root)).kind, "genuine-task-failures");
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    true
  );

  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const manifestPath = path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json");
  fs.rmSync(manifestPath);
  fs.mkdirSync(manifestPath);

  const operational = await syncRun({ projectRoot: project, runId: "sync-invalid-output", env });

  assert.equal(operational.ok, true, JSON.stringify(operational.diagnostics));
  assert.equal(operational.value?.status, "failed");
  assert.ok(operational.diagnostics.some((diagnostic) => diagnostic.source === "artifacts"));
  const operationalState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { provenance?: Record<string, unknown> }>;
  };
  assert.equal(operationalState.nodes?.["project-discovery"]?.provenance?.terminal_disposition, undefined);
  assert.equal((await terminalDispositionForRunRoot(run.value!.run_root)).kind, "operational-failure");
});

test("syncRun persists cumulative token accounting and partial pricing from workflow events", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const source = await startRun({
    projectRoot: project,
    runId: "source-accounting",
    env: fakeSmithersEnv(project)
  });
  assert.equal(source.ok, true, JSON.stringify(source.diagnostics));
  const sourceMetadataPath = path.join(source.value!.run_root, "run.json");
  const sourceMetadata = JSON.parse(fs.readFileSync(sourceMetadataPath, "utf8")) as Record<string, unknown>;
  // 0.1 + 0.2 exercises cumulative USD rounding instead of leaking binary float tails.
  fs.writeFileSync(
    sourceMetadataPath,
    `${JSON.stringify(
      {
        ...sourceMetadata,
        accounting: {
          schema_version: "1.0",
          source: "workflow-events",
          workflow_run_id: "ultrafuzz-source-accounting",
          current: {
            input_tokens: 40,
            output_tokens: 60,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 100,
            tokens_used: "100",
            estimated_spend: "$0.10",
            estimated_spend_usd: 0.1,
            partial_pricing: false,
            event_count: 1,
            priced_event_count: 1,
            unpriced_event_count: 0,
            models: ["source-model"],
            agents: ["codex"]
          },
          cumulative: {
            input_tokens: 40,
            output_tokens: 60,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 100,
            tokens_used: "100",
            estimated_spend: "$0.10",
            estimated_spend_usd: 0.1,
            partial_pricing: false,
            event_count: 1,
            priced_event_count: 1,
            unpriced_event_count: 0,
            models: ["source-model"],
            agents: ["codex"],
            source_run_ids: []
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const workflowRunId = "ultrafuzz-lineage-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 10,
          outputTokens: 20,
          costUsd: 0.2,
          model: "gpt-test",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 5,
          model: "gpt-test",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({
    projectRoot: project,
    runId: "lineage-accounting",
    sourceRunId: "source-accounting",
    env
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "lineage-accounting", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { tokens_used?: string; estimated_spend?: string; partial_pricing?: boolean };
      cumulative?: {
        tokens_used?: string;
        estimated_spend?: string;
        estimated_spend_usd?: number;
        partial_pricing?: boolean;
        source_run_ids?: string[];
      };
    };
  };
  assert.equal(metadata.accounting?.current?.tokens_used, "35");
  assert.equal(metadata.accounting?.current?.estimated_spend, "$0.20+");
  assert.equal(metadata.accounting?.current?.partial_pricing, true);
  assert.equal(metadata.accounting?.cumulative?.tokens_used, "135");
  assert.equal(metadata.accounting?.cumulative?.estimated_spend, "$0.30+");
  assert.equal(metadata.accounting?.cumulative?.estimated_spend_usd, 0.3);
  assert.equal(metadata.accounting?.cumulative?.partial_pricing, true);
  assert.deepEqual(metadata.accounting?.cumulative?.source_run_ids, ["source-accounting"]);
});

test("syncRun preserves generated usage across checkpoint generations and replays idempotently", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-generated-usage";
  const inspect = workflowInspect({
    workflowRunId,
    steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
  });
  const generatedSegment = (
    generation: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
    eventOffset: number
  ) =>
    workflowEvents(workflowRunId, [
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: eventOffset,
        extra: { iteration: 0 }
      },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: eventOffset + 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: generation,
          inputTokens,
          outputTokens,
          costUsd,
          model: "generated-model",
          agent: "generated-agent"
        }
      },
      {
        type: "NodeFinished",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: eventOffset + 2,
        extra: { iteration: 0 }
      },
      { type: "RunFinished", sequence: eventOffset + 3 }
    ]);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect,
    events: generatedSegment("generation-1", 10, 5, 0.01, 0)
  });
  const run = await startRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const first = await syncRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));

  const generatedEventsPath = path.join(project, "fake-smithers-events.ndjson");
  fs.writeFileSync(generatedEventsPath, generatedSegment("generation-2", 20, 10, 0.02, 10), "utf8");
  const second = await syncRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  const replayed = await syncRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));

  fs.writeFileSync(
    generatedEventsPath,
    workflowEvents(workflowRunId, [
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 20,
        extra: { iteration: 0 }
      },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 21,
        extra: {
          iteration: 0,
          checkpointGenerationId: "generation-3",
          inputTokens: "malformed",
          model: "generated-model",
          agent: "generated-agent"
        }
      },
      {
        type: "NodeFinished",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 22,
        extra: { iteration: 0 }
      },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 23,
        extra: { iteration: 0 }
      },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 24,
        extra: {
          iteration: 0,
          checkpointGenerationId: "generation-3",
          model: "generated-model",
          agent: "generated-agent"
        }
      },
      {
        type: "NodeFinished",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 25,
        extra: { iteration: 0 }
      },
      { type: "RunFinished", sequence: 26 }
    ]),
    "utf8"
  );
  const incomplete = await syncRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(incomplete.ok, true, JSON.stringify(incomplete.diagnostics));

  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        tokens_used?: string;
        usage_complete?: boolean;
        usage_incomplete_reasons?: Array<{ code?: string }>;
        pricing_complete?: boolean;
      };
      segments?: Array<{
        checkpoint_generation_id?: string;
        total_tokens?: number;
        event_count?: number;
      }>;
      cumulative?: { total_tokens?: number; event_count?: number; usage_complete?: boolean };
      checkpoint?: { ledger_event_count?: number; checkpoint_generation_id?: string };
    };
  };
  const segments = metadata.accounting?.segments ?? [];
  assert.deepEqual(
    segments.map((segment) => [segment.checkpoint_generation_id, segment.total_tokens, segment.event_count]),
    [
      ["generation-1", 15, 1],
      ["generation-2", 30, 1],
      ["generation-3", 0, 2]
    ]
  );
  assert.equal(
    segments.reduce((total, segment) => total + (segment.total_tokens ?? 0), 0),
    metadata.accounting?.cumulative?.total_tokens
  );
  assert.equal(metadata.accounting?.cumulative?.total_tokens, 45);
  assert.equal(metadata.accounting?.cumulative?.event_count, 4);
  assert.equal(metadata.accounting?.current?.tokens_used, "0");
  assert.equal(metadata.accounting?.current?.usage_complete, false);
  assert.deepEqual(
    new Set(metadata.accounting?.current?.usage_incomplete_reasons?.map((reason) => reason.code)),
    new Set(["usage-malformed", "usage-missing"])
  );
  assert.equal(metadata.accounting?.current?.pricing_complete, false);
  assert.equal(metadata.accounting?.cumulative?.usage_complete, false);
  assert.equal(metadata.accounting?.checkpoint?.ledger_event_count, 4);
  assert.equal(metadata.accounting?.checkpoint?.checkpoint_generation_id, "generation-3");
  assert.equal(
    fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8").trim().split("\n").length,
    4,
    "replaying a continuation must not duplicate generated usage"
  );
});

test("syncRun keeps colliding checkpoint names separate across workflow runs", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const firstWorkflowRunId = "ultrafuzz-colliding-generation";
  const secondWorkflowRunId = "ultrafuzz-colliding-generation-fork";
  const usageEvents = (workflowRunId: string, inputTokens: number) =>
    workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "generation-shared",
          inputTokens,
          costUsd: inputTokens / 1_000,
          model: "generated-model",
          agent: "generated-agent"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ]);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: firstWorkflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: usageEvents(firstWorkflowRunId, 10),
    timeline: {
      data: { timeline: { runId: firstWorkflowRunId, frames: [{ frameNo: 7, forks: [] }], children: [] } }
    },
    replayRunId: secondWorkflowRunId
  });
  const run = await startRun({ projectRoot: project, runId: "colliding-generation", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const first = await syncRun({ projectRoot: project, runId: "colliding-generation", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));

  const metadataPath = path.join(run.value!.run_root, "run.json");
  fs.writeFileSync(
    path.join(project, "fake-smithers-inspect.json"),
    `${JSON.stringify(
      workflowInspect({
        workflowRunId: secondWorkflowRunId,
        steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
      }),
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(project, "fake-smithers-events.ndjson"), usageEvents(secondWorkflowRunId, 20), "utf8");
  const linked = await replayRun({ projectRoot: project, runId: "colliding-generation", forkFrame: 7, env });
  assert.equal(linked.ok, true, JSON.stringify(linked.diagnostics));
  assert.equal(linked.value?.workflow_run_id, secondWorkflowRunId);

  const second = await syncRun({ projectRoot: project, runId: "colliding-generation", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  const finalMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    accounting?: {
      current?: { workflow_run_id?: string; total_tokens?: number };
      segments?: Array<{ workflow_run_id?: string; checkpoint_generation_id?: string; total_tokens?: number }>;
      cumulative?: { total_tokens?: number };
      checkpoint?: { workflow_run_id?: string };
    };
  };
  assert.deepEqual(
    finalMetadata.accounting?.segments?.map((segment) => [
      segment.workflow_run_id,
      segment.checkpoint_generation_id,
      segment.total_tokens
    ]),
    [
      [firstWorkflowRunId, "generation-shared", 10],
      [secondWorkflowRunId, "generation-shared", 20]
    ]
  );
  assert.equal(finalMetadata.accounting?.current?.workflow_run_id, secondWorkflowRunId);
  assert.equal(finalMetadata.accounting?.current?.total_tokens, 20);
  assert.equal(finalMetadata.accounting?.cumulative?.total_tokens, 30);
  assert.equal(finalMetadata.accounting?.checkpoint?.workflow_run_id, secondWorkflowRunId);
});

test("syncRun counts cache-only usage when aggregate input is explicitly zero", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-cache-only-usage";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "generation-cache",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 12,
          cacheWriteTokens: 3,
          totalTokens: 0,
          costUsd: 0.000012
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "cache-only-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "cache-only-usage", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        total_tokens?: number;
        cache_read_tokens?: number;
        cache_write_tokens?: number;
        event_count?: number;
        usage_complete?: boolean;
        pricing_complete?: boolean;
        estimated_spend_usd?: number;
      };
    };
  };
  assert.equal(metadata.accounting?.current?.total_tokens, 15);
  assert.equal(metadata.accounting?.current?.cache_read_tokens, 12);
  assert.equal(metadata.accounting?.current?.cache_write_tokens, 3);
  assert.equal(metadata.accounting?.current?.event_count, 1);
  assert.equal(metadata.accounting?.current?.usage_complete, true);
  assert.equal(metadata.accounting?.current?.pricing_complete, false);
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, 0.000012);
});

test("syncRun preserves sub-microdollar costs across generation rollups", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-precise-cost-usage";
  const generatedSegment = (generation: string, eventOffset: number) =>
    workflowEvents(workflowRunId, [
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: eventOffset,
        extra: { iteration: 0 }
      },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: eventOffset + 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: generation,
          inputTokens: 1,
          outputTokens: 0,
          costUsd: 0.0000004
        }
      },
      {
        type: "NodeFinished",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: eventOffset + 2,
        extra: { iteration: 0 }
      },
      { type: "RunFinished", sequence: eventOffset + 3 }
    ]);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: generatedSegment("generation-1", 0)
  });
  const run = await startRun({ projectRoot: project, runId: "precise-cost-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const first = await syncRun({ projectRoot: project, runId: "precise-cost-usage", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  fs.writeFileSync(path.join(project, "fake-smithers-events.ndjson"), generatedSegment("generation-2", 10), "utf8");

  const second = await syncRun({ projectRoot: project, runId: "precise-cost-usage", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      segments?: Array<{ estimated_spend_usd?: number }>;
      cumulative?: { estimated_spend_usd?: number };
    };
  };
  assert.deepEqual(
    metadata.accounting?.segments?.map((segment) => segment.estimated_spend_usd),
    [0.0000004, 0.0000004]
  );
  assert.equal(metadata.accounting?.cumulative?.estimated_spend_usd, 0.0000008);
});

test("syncRun uses durable event sequence for the current accounting segment", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-sequenced-usage";
  const event = (seq: number, timestampMs: number, type: string, payload: Record<string, unknown> = {}) =>
    JSON.stringify({
      runId: workflowRunId,
      seq,
      timestampMs,
      type,
      payload: { runId: workflowRunId, timestampMs, type, ...payload }
    });
  const events = `${[
    event(0, 100, "NodeStarted", { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }),
    event(1, 300, "TokenUsageReported", {
      nodeId: "node:project-discovery",
      iteration: 0,
      attempt: 1,
      checkpointGenerationId: "generation-1",
      inputTokens: 10,
      costUsd: 0.01
    }),
    event(2, 350, "NodeFinished", { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }),
    event(3, 150, "NodeStarted", { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }),
    event(4, 200, "TokenUsageReported", {
      nodeId: "node:project-discovery",
      iteration: 0,
      attempt: 1,
      checkpointGenerationId: "generation-2",
      inputTokens: 20,
      costUsd: 0.02
    }),
    event(5, 400, "NodeFinished", { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }),
    event(6, 500, "RunFinished")
  ].join("\n")}\n`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events
  });
  const run = await startRun({ projectRoot: project, runId: "sequenced-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sequenced-usage", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { checkpoint_generation_id?: string; total_tokens?: number };
      segments?: Array<{ checkpoint_generation_id?: string; total_tokens?: number }>;
    };
  };
  assert.deepEqual(
    metadata.accounting?.segments?.map((segment) => [segment.checkpoint_generation_id, segment.total_tokens]),
    [
      ["generation-1", 10],
      ["generation-2", 20]
    ]
  );
  assert.equal(metadata.accounting?.current?.checkpoint_generation_id, "generation-2");
  assert.equal(metadata.accounting?.current?.total_tokens, 20);
});

test("syncRun assigns unseen implicit usage events to a new checkpoint segment", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-implicit-usage";
  const tokenEvent = (inputTokens: number, outputTokens: number, costUsd: number) => ({
    type: "TokenUsageReported",
    nodeId: "node:project-discovery",
    attempt: 1,
    extra: {
      iteration: 0,
      inputTokens,
      outputTokens,
      costUsd,
      model: "generated-model",
      agent: "generated-agent"
    }
  });
  const firstSegment = [
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
    tokenEvent(10, 5, 0.01),
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
    { type: "RunFinished" }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, firstSegment)
  });
  const run = await startRun({ projectRoot: project, runId: "implicit-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const first = await syncRun({ projectRoot: project, runId: "implicit-usage", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));

  fs.writeFileSync(
    path.join(project, "fake-smithers-events.ndjson"),
    workflowEvents(workflowRunId, [
      ...firstSegment.slice(0, -1),
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      tokenEvent(20, 10, 0.02),
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ]),
    "utf8"
  );
  const second = await syncRun({ projectRoot: project, runId: "implicit-usage", env });
  const replayed = await syncRun({ projectRoot: project, runId: "implicit-usage", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));

  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      segments?: Array<{ checkpoint_generation_id?: string; total_tokens?: number; event_count?: number }>;
      cumulative?: { total_tokens?: number; event_count?: number };
    };
  };
  const segments = metadata.accounting?.segments ?? [];
  assert.deepEqual(
    segments.map((segment) => [segment.total_tokens, segment.event_count]),
    [
      [15, 1],
      [30, 1]
    ]
  );
  assert.notEqual(segments[0]?.checkpoint_generation_id, segments[1]?.checkpoint_generation_id);
  assert.equal(metadata.accounting?.cumulative?.total_tokens, 45);
  assert.equal(metadata.accounting?.cumulative?.event_count, 2);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("syncRun never rebinds a partial token snapshot to an already durable invocation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-partial-token-snapshot";
  const base = Date.parse("2026-07-03T00:00:00.000Z");
  const tokenEvent = (sequence: number, inputTokens: number, outputTokens: number) => ({
    type: "TokenUsageReported",
    nodeId: "node:project-discovery",
    attempt: 1,
    sequence,
    timestampMs: base + sequence * 100,
    extra: {
      iteration: 0,
      checkpointGenerationId: "generation-shared",
      inputTokens,
      outputTokens,
      costUsd: (inputTokens + outputTokens) / 1_000,
      model: "gpt-test",
      agent: "codex"
    }
  });
  const firstToken = tokenEvent(1, 10, 5);
  const secondToken = tokenEvent(6, 20, 10);
  const firstLifecycle = [
    {
      type: "NodeStarted",
      nodeId: "node:project-discovery",
      attempt: 1,
      sequence: 0,
      timestampMs: base,
      extra: { iteration: 0 }
    },
    firstToken,
    {
      type: "NodeFinished",
      nodeId: "node:project-discovery",
      attempt: 1,
      sequence: 2,
      timestampMs: base + 200,
      extra: { iteration: 0 }
    },
    { type: "RunFinished", sequence: 3, timestampMs: base + 300 }
  ];
  const continuedLifecycle = [
    ...firstLifecycle,
    { type: "RunAutoResumed", sequence: 4, timestampMs: base + 400 },
    {
      type: "NodeStarted",
      nodeId: "node:project-discovery",
      attempt: 1,
      sequence: 5,
      timestampMs: base + 500,
      extra: { iteration: 0 }
    },
    secondToken,
    {
      type: "NodeFinished",
      nodeId: "node:project-discovery",
      attempt: 1,
      sequence: 7,
      timestampMs: base + 700,
      extra: { iteration: 0 }
    },
    { type: "RunFinished", sequence: 8, timestampMs: base + 800 }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, firstLifecycle),
    tokenEvents: workflowEvents(workflowRunId, [firstToken])
  });
  const run = await startRun({
    projectRoot: project,
    runId: "partial-token-snapshot",
    model: "gpt-test",
    env
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const first = await syncRun({ projectRoot: project, runId: "partial-token-snapshot", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));

  fs.writeFileSync(env.SMITHERS_FAKE_EVENTS!, workflowEvents(workflowRunId, continuedLifecycle), "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_TOKEN_EVENTS!, workflowEvents(workflowRunId, [secondToken]), "utf8");
  const second = await syncRun({ projectRoot: project, runId: "partial-token-snapshot", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));

  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { total_tokens?: number; event_count?: number };
      cumulative?: { total_tokens?: number; event_count?: number };
      model_identity?: { status?: string; invocation_count?: number; invocations?: Array<{ invocation_id?: string }> };
    };
  };
  assert.equal(metadata.accounting?.current?.total_tokens, 45);
  assert.equal(metadata.accounting?.current?.event_count, 2);
  assert.equal(metadata.accounting?.cumulative?.total_tokens, 45);
  assert.equal(metadata.accounting?.cumulative?.event_count, 2);
  assert.equal(metadata.accounting?.model_identity?.status, "complete");
  assert.equal(metadata.accounting?.model_identity?.invocation_count, 2);
  const invocationIds = metadata.accounting?.model_identity?.invocations?.map((entry) => entry.invocation_id) ?? [];
  assert.equal(new Set(invocationIds).size, 2);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("syncRun propagates malformed-only usage ledger state into cumulative accounting", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-malformed-only-usage";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "malformed-only-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  fs.writeFileSync(path.join(run.value!.run_root, "usage.jsonl"), "{malformed\n", "utf8");

  const sync = await syncRun({ projectRoot: project, runId: "malformed-only-usage", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));

  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { event_count?: number; usage_complete?: boolean; usage_incomplete_reasons?: Array<{ code?: string }> };
      segments?: Array<{ event_count?: number; usage_complete?: boolean }>;
      cumulative?: {
        event_count?: number;
        usage_complete?: boolean;
        usage_incomplete_reasons?: Array<{ code?: string }>;
      };
      checkpoint?: { malformed_entry_count?: number };
    };
  };
  assert.equal(metadata.accounting?.current?.event_count, 1);
  assert.equal(metadata.accounting?.current?.usage_complete, false);
  assert.equal(metadata.accounting?.segments?.length, 1);
  assert.equal(metadata.accounting?.segments?.[0]?.event_count, 1);
  assert.equal(metadata.accounting?.segments?.[0]?.usage_complete, false);
  assert.equal(metadata.accounting?.cumulative?.event_count, 1);
  assert.equal(metadata.accounting?.cumulative?.usage_complete, false);
  assert.deepEqual(
    metadata.accounting?.current?.usage_incomplete_reasons?.map((reason) => reason.code),
    ["ledger-entry-malformed"]
  );
  assert.deepEqual(
    metadata.accounting?.cumulative?.usage_incomplete_reasons?.map((reason) => reason.code),
    ["ledger-entry-malformed"]
  );
  assert.equal(metadata.accounting?.checkpoint?.malformed_entry_count, 1);
});

test("syncRun records unavailable spend when workflow token events are unpriced", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-unpriced-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 10,
          outputTokens: 20,
          model: "gpt-test",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({
    projectRoot: project,
    runId: "unpriced-accounting",
    env
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "unpriced-accounting", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        tokens_used?: string;
        estimated_spend?: string;
        usage_complete?: boolean;
        usage_incomplete_reasons?: Array<{ code?: string; component?: string; model?: string }>;
        partial_pricing?: boolean;
      };
      cumulative?: { tokens_used?: string; estimated_spend?: string; partial_pricing?: boolean };
    };
  };
  assert.equal(metadata.accounting?.current?.tokens_used, "30");
  assert.equal(metadata.accounting?.current?.estimated_spend, "unavailable");
  assert.equal(metadata.accounting?.current?.usage_complete, false);
  assert.deepEqual(metadata.accounting?.current?.usage_incomplete_reasons, [
    {
      code: "component-usage-unavailable",
      component: "cache_read",
      model: "gpt-test"
    }
  ]);
  assert.equal(metadata.accounting?.current?.partial_pricing, true);
  assert.equal(metadata.accounting?.cumulative?.tokens_used, "30");
  assert.equal(metadata.accounting?.cumulative?.estimated_spend, "unavailable");
  assert.equal(metadata.accounting?.cumulative?.partial_pricing, true);
});

test("syncRun retries transient pricing catalog failures", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-transient-pricing-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 100_000,
          outputTokens: 10_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "gpt-test",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = "data:application/json,%7B";
  const run = await startRun({ projectRoot: project, runId: "transient-pricing-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const failedSync = await syncRun({ projectRoot: project, runId: "transient-pricing-accounting", env });
  assert.equal(failedSync.ok, true, JSON.stringify(failedSync.diagnostics));
  const failedMetadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { estimated_spend?: string };
      pricing_catalog?: { status?: string; unresolved_models?: string[] };
    };
  };
  assert.equal(failedMetadata.accounting?.current?.estimated_spend, "unavailable");
  assert.equal(failedMetadata.accounting?.pricing_catalog?.status, "unavailable");
  assert.deepEqual(failedMetadata.accounting?.pricing_catalog?.unresolved_models, ["gpt-test"]);

  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-test": { cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 } }
      }
    }
  });
  const recoveredSync = await syncRun({ projectRoot: project, runId: "transient-pricing-accounting", env });
  assert.equal(recoveredSync.ok, true, JSON.stringify(recoveredSync.diagnostics));
  const recoveredMetadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { estimated_spend?: string; partial_pricing?: boolean };
      pricing_catalog?: { status?: string; resolved_models?: string[]; unresolved_models?: string[] };
    };
  };
  assert.equal(recoveredMetadata.accounting?.current?.estimated_spend, "$0.80");
  assert.equal(recoveredMetadata.accounting?.current?.partial_pricing, false);
  assert.equal(recoveredMetadata.accounting?.pricing_catalog?.status, "available");
  assert.deepEqual(recoveredMetadata.accounting?.pricing_catalog?.resolved_models, ["gpt-test"]);
  assert.deepEqual(recoveredMetadata.accounting?.pricing_catalog?.unresolved_models, []);
});

test("syncRun refreshes every required model price atomically from one raw catalog response", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-atomic-pricing-refresh";
  const usageEvent = (model: string, sequence: number) => ({
    type: "TokenUsageReported",
    nodeId: "node:project-discovery",
    attempt: 1,
    sequence,
    extra: {
      iteration: 0,
      checkpointGenerationId: "generation-shared",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model,
      agent: "codex"
    }
  });
  const firstEvents = [
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, sequence: 0 },
    usageEvent("model-a", 1),
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, sequence: 2 },
    { type: "RunFinished", sequence: 3 }
  ];
  const secondEvents = [
    ...firstEvents,
    { type: "RunAutoResumed", sequence: 4 },
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, sequence: 5 },
    usageEvent("model-b", 6),
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, sequence: 7 },
    { type: "RunFinished", sequence: 8 }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, firstEvents)
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: { models: { "model-a": { cost: { input: 1, output: 1, cache_read: 1, cache_write: 1 } } } }
  });
  const run = await startRun({ projectRoot: project, runId: "atomic-pricing-refresh", model: "model-a", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const first = await syncRun({ projectRoot: project, runId: "atomic-pricing-refresh", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));

  const replacementCatalog = {
    openai: {
      models: {
        "model-a": { cost: { input: 10, output: 10, cache_read: 10, cache_write: 10 } },
        "model-b": { cost: { input: 20, output: 20, cache_read: 20, cache_write: 20 } }
      }
    }
  };
  const replacementBytes = Buffer.from(JSON.stringify(replacementCatalog), "utf8");
  const replacementDigest = crypto.createHash("sha256").update(replacementBytes).digest("hex");
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl(replacementCatalog);
  fs.writeFileSync(env.SMITHERS_FAKE_EVENTS!, workflowEvents(workflowRunId, secondEvents), "utf8");
  const refreshed = await syncRun({ projectRoot: project, runId: "atomic-pricing-refresh", env });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed.diagnostics));

  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { estimated_spend_usd?: number; event_count?: number };
      cumulative?: { estimated_spend_usd?: number; event_count?: number };
      pricing_catalog?: {
        catalog_sha256?: string;
        resolved_models?: string[];
        model_prices?: Record<string, { inputUsdPerMillion?: number }>;
      };
    };
  };
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, 30);
  assert.equal(metadata.accounting?.current?.event_count, 2);
  assert.equal(metadata.accounting?.cumulative?.estimated_spend_usd, 30);
  assert.equal(metadata.accounting?.cumulative?.event_count, 2);
  assert.equal(metadata.accounting?.pricing_catalog?.catalog_sha256, replacementDigest);
  assert.deepEqual(metadata.accounting?.pricing_catalog?.resolved_models, ["model-a", "model-b"]);
  assert.equal(metadata.accounting?.pricing_catalog?.model_prices?.["model-a"]?.inputUsdPerMillion, 10);
  assert.equal(metadata.accounting?.pricing_catalog?.model_prices?.["model-b"]?.inputUsdPerMillion, 20);
  assert.deepEqual(
    fs.readFileSync(getPricingCatalogSnapshotPath(layoutForRunRoot(run.value!.run_root), replacementDigest)),
    replacementBytes
  );
});

test("syncRun prices independent usage components when cache reads exceed uncached input", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-estimated-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 100_000,
          outputTokens: 10_000,
          cacheReadTokens: 200_000,
          cacheWriteTokens: 10_000,
          reasoningTokens: 5_000,
          model: "gpt-5.6-sol",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 12,
          cacheWriteTokens: 3,
          totalTokens: 0,
          model: "gpt-5.6-sol",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-5.6-sol": {
          cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 }
        }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "estimated-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "estimated-accounting", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        tokens_used?: string;
        inclusive_token_total?: number;
        billable_token_total?: number;
        estimated_spend?: string;
        estimated_spend_usd?: number;
        component_costs_usd?: Record<string, number>;
        usage_complete?: boolean;
        pricing_complete?: boolean;
        partial_pricing?: boolean;
        priced_event_count?: number;
        unpriced_event_count?: number;
      };
      cumulative?: {
        inclusive_token_total?: number;
        billable_token_total?: number;
        estimated_spend_usd?: number;
        component_costs_usd?: Record<string, number>;
      };
      pricing_catalog?: {
        source?: string;
        status?: string;
        resolved_models?: string[];
        model_prices?: Record<string, unknown>;
      };
      updated_at?: string;
    };
  };
  assert.equal(metadata.accounting?.current?.tokens_used, "325,015");
  assert.equal(metadata.accounting?.current?.inclusive_token_total, 325_015);
  assert.equal(metadata.accounting?.current?.billable_token_total, 325_015);
  assert.equal(metadata.accounting?.current?.estimated_spend, "$1.11");
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, 1.11252475);
  assert.deepEqual(metadata.accounting?.current?.component_costs_usd, {
    uncached_input: 0.5,
    cache_read: 0.100006,
    cache_write: 0.06251875,
    output: 0.3,
    reasoning: 0.15
  });
  assert.equal(
    Number(
      Object.values(metadata.accounting?.current?.component_costs_usd ?? {})
        .reduce((total, cost) => total + cost, 0)
        .toFixed(12)
    ),
    metadata.accounting?.current?.estimated_spend_usd
  );
  assert.equal(metadata.accounting?.current?.usage_complete, true);
  assert.equal(metadata.accounting?.current?.pricing_complete, true);
  assert.equal(metadata.accounting?.current?.partial_pricing, false);
  assert.equal(metadata.accounting?.current?.priced_event_count, 2);
  assert.equal(metadata.accounting?.current?.unpriced_event_count, 0);
  assert.equal(metadata.accounting?.cumulative?.inclusive_token_total, 325_015);
  assert.equal(metadata.accounting?.cumulative?.billable_token_total, 325_015);
  assert.equal(metadata.accounting?.cumulative?.estimated_spend_usd, 1.11252475);
  assert.deepEqual(
    metadata.accounting?.cumulative?.component_costs_usd,
    metadata.accounting?.current?.component_costs_usd
  );
  assert.equal(metadata.accounting?.pricing_catalog?.source, "configured-catalog");
  assert.equal(metadata.accounting?.pricing_catalog?.status, "available");
  assert.deepEqual(metadata.accounting?.pricing_catalog?.resolved_models, ["gpt-5.6-sol"]);
  assert.ok(metadata.accounting?.pricing_catalog?.model_prices?.["gpt-5.6-sol"]);

  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-5.6-sol": {
          cost: { input: 50, output: 300, cache_read: 5, cache_write: 62.5 }
        }
      }
    }
  });
  const resync = await syncRun({ projectRoot: project, runId: "estimated-accounting", env });
  assert.equal(resync.ok, true, JSON.stringify(resync.diagnostics));
  const resyncedMetadata = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")
  ) as typeof metadata;
  assert.equal(resyncedMetadata.accounting?.current?.estimated_spend, "$1.11");
  assert.deepEqual(resyncedMetadata.accounting?.current, metadata.accounting?.current);
  assert.deepEqual(resyncedMetadata.accounting?.cumulative, metadata.accounting?.cumulative);
  assert.equal(resyncedMetadata.accounting?.updated_at, metadata.accounting?.updated_at);
});

test("syncRun records a typed incomplete-pricing reason for a missing component rate", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-component-pricing";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 10_000,
          outputTokens: 1_000,
          cacheReadTokens: 20_000,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          model: "gpt-component-test",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-component-test": { cost: { input: 5, output: 30, cache_write: 6.25 } }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "component-pricing", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "component-pricing", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        inclusive_token_total?: number;
        billable_token_total?: number;
        estimated_spend?: string;
        estimated_spend_usd?: number;
        component_costs_usd?: Record<string, number>;
        usage_complete?: boolean;
        pricing_complete?: boolean;
        pricing_incomplete_reasons?: Array<{ code?: string; component?: string; model?: string }>;
      };
    };
  };
  assert.equal(metadata.accounting?.current?.inclusive_token_total, 31_000);
  assert.equal(metadata.accounting?.current?.billable_token_total, 11_000);
  assert.equal(metadata.accounting?.current?.estimated_spend, "$0.08+");
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, 0.08);
  assert.deepEqual(metadata.accounting?.current?.component_costs_usd, {
    uncached_input: 0.05,
    cache_read: 0,
    cache_write: 0,
    output: 0.03,
    reasoning: 0
  });
  assert.equal(metadata.accounting?.current?.usage_complete, true);
  assert.equal(metadata.accounting?.current?.pricing_complete, false);
  assert.deepEqual(metadata.accounting?.current?.pricing_incomplete_reasons, [
    {
      code: "component-rate-unavailable",
      component: "cache_read",
      model: "gpt-component-test"
    }
  ]);
});

test("syncRun applies context-tier pricing from the live catalog", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-tiered-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 300_000,
          outputTokens: 10_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "gpt-tiered",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-tiered": {
          cost: {
            input: 5,
            output: 30,
            cache_read: 0.5,
            tiers: [
              {
                input: 10,
                output: 45,
                cache_read: 1,
                tier: { type: "context", size: 272_000 }
              }
            ]
          }
        }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "tiered-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "tiered-accounting", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: { current?: { tokens_used?: string; estimated_spend?: string; partial_pricing?: boolean } };
  };
  assert.equal(metadata.accounting?.current?.tokens_used, "310,000");
  assert.equal(metadata.accounting?.current?.estimated_spend, "$3.45");
  assert.equal(metadata.accounting?.current?.partial_pricing, false);
});

test("syncRun publishes complete DeepSeek V4 telemetry at first-party list rates", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-deepseek-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 120_000,
          outputTokens: 8_000,
          cacheReadTokens: 400_000,
          cacheWriteTokens: 0,
          // DeepSeek output already includes thinking tokens, so its separate
          // reasoning component is an authoritative zero.
          reasoningTokens: 0,
          model: "deepseek-v4-pro",
          agent: "DeepSeekAgent"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    "alibaba-token-plan": {
      models: {
        "deepseek-v4-pro": { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }
      }
    },
    deepseek: {
      models: {
        "deepseek-v4-pro": { cost: { input: 0.435, output: 0.87, reasoning: 0.87, cache_read: 0.003625 } }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "deepseek-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "deepseek-accounting", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const accounting = (
    JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
      accounting?: {
        current?: {
          uncached_input_tokens?: number;
          output_tokens?: number;
          cache_read_tokens?: number;
          cache_write_tokens?: number;
          reasoning_tokens?: number;
          inclusive_token_total?: number;
          billable_token_total?: number;
          estimated_spend_usd?: number;
          estimated_spend?: string;
          component_costs_usd?: Record<string, number>;
          usage_complete?: boolean;
          pricing_complete?: boolean;
          partial_pricing?: boolean;
          models?: string[];
          agents?: string[];
        };
        pricing_catalog?: {
          resolved_models?: string[];
          model_prices?: Record<string, { inputUsdPerMillion?: number; cachedInputUsdPerMillion?: number }>;
        };
      };
    }
  ).accounting;
  assert.equal(accounting?.current?.uncached_input_tokens, 120_000);
  assert.equal(accounting?.current?.cache_read_tokens, 400_000);
  assert.equal(accounting?.current?.cache_write_tokens, 0);
  assert.equal(accounting?.current?.output_tokens, 8_000);
  assert.equal(accounting?.current?.reasoning_tokens, 0);
  assert.equal(accounting?.current?.inclusive_token_total, 528_000);
  assert.equal(accounting?.current?.billable_token_total, 528_000);
  assert.equal(accounting?.current?.estimated_spend, "$0.06");
  assert.equal(accounting?.current?.estimated_spend_usd, 0.06061);
  assert.deepEqual(accounting?.current?.component_costs_usd, {
    uncached_input: 0.0522,
    cache_read: 0.00145,
    cache_write: 0,
    output: 0.00696,
    reasoning: 0
  });
  assert.equal(accounting?.current?.usage_complete, true);
  assert.equal(accounting?.current?.pricing_complete, true);
  assert.equal(accounting?.current?.partial_pricing, false);
  assert.deepEqual(accounting?.current?.models, ["deepseek-v4-pro"]);
  assert.deepEqual(accounting?.current?.agents, ["DeepSeekAgent"]);
  assert.deepEqual(accounting?.pricing_catalog?.resolved_models, ["deepseek-v4-pro"]);
  assert.equal(accounting?.pricing_catalog?.model_prices?.["deepseek-v4-pro"]?.inputUsdPerMillion, 0.435);
  assert.equal(accounting?.pricing_catalog?.model_prices?.["deepseek-v4-pro"]?.cachedInputUsdPerMillion, 0.003625);
});

test("syncRun prices deepseek-v4-flash at exact first-party publication rates", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-deepseek-v4-flash-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 120_000,
          outputTokens: 8_000,
          cacheReadTokens: 400_000,
          cacheWriteTokens: 0,
          // DeepSeek output already includes thinking tokens. Even if an
          // upstream runner repeats the subset here, accounting must not add
          // or charge it a second time.
          reasoningTokens: 4_000,
          model: "deepseek-v4-flash",
          agent: "DeepSeekAgent"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const pricingCatalog = {
    "alibaba-token-plan": {
      models: {
        "deepseek-v4-flash": { cost: { input: 0, output: 0, cache_read: 0, reasoning: 0 } }
      }
    },
    deepseek: {
      models: {
        "deepseek-v4-flash": { cost: { input: 0.14, output: 0.28, reasoning: 0.28, cache_read: 0.0028 } }
      }
    }
  };
  const rawPricingCatalog = Buffer.from(JSON.stringify(pricingCatalog), "utf8");
  const pricingCatalogSha256 = crypto.createHash("sha256").update(rawPricingCatalog).digest("hex");
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl(pricingCatalog);
  const run = await startRun({
    projectRoot: project,
    runId: "deepseek-v4-flash-accounting",
    agent: "DeepSeekAgent",
    model: "deepseek-v4-flash",
    env
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "deepseek-v4-flash-accounting", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const accounting = (
    JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
      accounting?: {
        current?: {
          estimated_spend?: string;
          estimated_spend_usd?: number;
          component_costs_usd?: Record<string, number>;
          pricing_complete?: boolean;
          models?: string[];
          reasoning_tokens?: number;
          event_count?: number;
        };
        cumulative?: { event_count?: number; reasoning_tokens?: number; estimated_spend_usd?: number };
        model_identity?: {
          schema_version?: string;
          status?: string;
          invocation_count?: number;
          configured_models?: string[];
          provider_reported_models?: string[];
          invocations?: Array<{
            invocation_id?: string;
            configured_model?: string;
            provider_reported_model?: string;
          }>;
        };
        pricing_catalog?: {
          catalog_sha256?: string;
          resolved_models?: string[];
          model_prices?: Record<
            string,
            {
              inputUsdPerMillion?: number;
              cachedInputUsdPerMillion?: number;
              outputUsdPerMillion?: number;
              reasoningUsdPerMillion?: number;
            }
          >;
        };
      };
    }
  ).accounting;
  assert.equal(accounting?.current?.estimated_spend, "$0.02");
  assert.equal(accounting?.current?.estimated_spend_usd, 0.02016);
  assert.deepEqual(accounting?.current?.component_costs_usd, {
    uncached_input: 0.0168,
    cache_read: 0.00112,
    cache_write: 0,
    output: 0.00224,
    reasoning: 0
  });
  assert.equal(accounting?.current?.pricing_complete, true);
  assert.equal(accounting?.current?.reasoning_tokens, 0);
  assert.equal(accounting?.current?.event_count, 1);
  assert.equal(accounting?.cumulative?.reasoning_tokens, 0);
  assert.equal(accounting?.cumulative?.estimated_spend_usd, accounting?.current?.estimated_spend_usd);
  assert.equal(accounting?.cumulative?.event_count, 1);
  assert.deepEqual(accounting?.current?.models, ["deepseek-v4-flash"]);
  assert.deepEqual(accounting?.model_identity, {
    schema_version: "ultrafuzz.runtime.model-identity.v1",
    status: "complete",
    invocation_count: 1,
    configured_models: ["deepseek-v4-flash"],
    provider_reported_models: ["deepseek-v4-flash"],
    invocations: [
      {
        invocation_id: accounting?.model_identity?.invocations?.[0]?.invocation_id,
        configured_model: "deepseek-v4-flash",
        provider_reported_model: "deepseek-v4-flash"
      }
    ]
  });
  assert.match(
    accounting?.model_identity?.invocations?.[0]?.invocation_id ?? "",
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u
  );
  assert.deepEqual(accounting?.pricing_catalog?.resolved_models, ["deepseek-v4-flash"]);
  assert.equal(accounting?.pricing_catalog?.catalog_sha256, pricingCatalogSha256);
  assert.equal(accounting?.pricing_catalog?.model_prices?.["deepseek-v4-flash"]?.inputUsdPerMillion, 0.14);
  assert.equal(accounting?.pricing_catalog?.model_prices?.["deepseek-v4-flash"]?.cachedInputUsdPerMillion, 0.0028);
  assert.equal(accounting?.pricing_catalog?.model_prices?.["deepseek-v4-flash"]?.outputUsdPerMillion, 0.28);
  assert.equal(accounting?.pricing_catalog?.model_prices?.["deepseek-v4-flash"]?.reasoningUsdPerMillion, 0.28);

  const layout = layoutForRunRoot(run.value!.run_root);
  const catalogSnapshotPath = getPricingCatalogSnapshotPath(layout, pricingCatalogSha256);
  assert.deepEqual(fs.readFileSync(catalogSnapshotPath), rawPricingCatalog);
  const metadataPath = path.join(run.value!.run_root, "run.json");
  const substitutedMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    accounting: {
      pricing_catalog: {
        model_prices: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>;
      };
    };
  };
  substitutedMetadata.accounting.pricing_catalog.model_prices["deepseek-v4-flash"]!.inputUsdPerMillion = 999;
  substitutedMetadata.accounting.pricing_catalog.model_prices["deepseek-v4-flash"]!.outputUsdPerMillion = 999;
  fs.writeFileSync(metadataPath, `${JSON.stringify(substitutedMetadata, null, 2)}\n`, "utf8");
  const repairedPricing = await syncRun({ projectRoot: project, runId: "deepseek-v4-flash-accounting", env });
  assert.equal(repairedPricing.ok, true, JSON.stringify(repairedPricing.diagnostics));
  const repairedMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    accounting?: {
      pricing_catalog?: {
        model_prices?: Record<string, { inputUsdPerMillion?: number; outputUsdPerMillion?: number }>;
      };
    };
  };
  assert.equal(
    repairedMetadata.accounting?.pricing_catalog?.model_prices?.["deepseek-v4-flash"]?.inputUsdPerMillion,
    0.14
  );
  assert.equal(
    repairedMetadata.accounting?.pricing_catalog?.model_prices?.["deepseek-v4-flash"]?.outputUsdPerMillion,
    0.28
  );
  const linkedSnapshotPath = path.join(project, "linked-pricing-catalog.json");
  fs.linkSync(catalogSnapshotPath, linkedSnapshotPath);
  await assert.rejects(
    syncRun({ projectRoot: project, runId: "deepseek-v4-flash-accounting", env }),
    /stored pricing catalog snapshot is missing, linked, malformed, or digest-mismatched/u
  );
});

test("syncRun reconciles matching and contradictory token/terminal provider identities", async () => {
  for (const testCase of [
    { label: "matching", terminalModel: "deepseek-v4-flash", expectedStatus: "complete" },
    {
      label: "contradictory",
      terminalModel: "deepseek-v4-pro",
      expectedStatus: "mixed"
    }
  ] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `provider-identity-${testCase.label}`;
    const workflowRunId = `ultrafuzz-${runId}`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId,
        status: "failed",
        state: "failed",
        steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
      }),
      events: workflowEvents(workflowRunId, [
        { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
        {
          type: "TokenUsageReported",
          nodeId: "node:project-discovery",
          attempt: 1,
          extra: {
            iteration: 0,
            inputTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 5,
            reasoningTokens: 0,
            model: "deepseek-v4-flash",
            agent: "DeepSeekAgent"
          }
        },
        {
          type: "NodeFailed",
          nodeId: "node:project-discovery",
          attempt: 1,
          error: { result: { response: { modelId: testCase.terminalModel } } },
          extra: { iteration: 0 }
        },
        { type: "RunFailed" }
      ])
    });
    env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
      deepseek: {
        models: {
          "deepseek-v4-flash": { cost: { input: 0.14, cache_read: 0.0028, output: 0.28, reasoning: 0.28 } },
          "ultrafuzz-provider-identity-mixed": {
            cost: { input: 0.14, cache_read: 0.0028, output: 0.28, reasoning: 0.28 }
          }
        }
      }
    });
    const run = await startRun({
      projectRoot: project,
      runId,
      agent: "DeepSeekAgent",
      model: "deepseek-v4-flash",
      env
    });
    assert.equal(run.ok, true, `${testCase.label}: ${JSON.stringify(run.diagnostics)}`);

    const sync = await syncRun({ projectRoot: project, runId, env });
    assert.equal(sync.ok, true, `${testCase.label}: ${JSON.stringify(sync.diagnostics)}`);
    const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
      accounting?: {
        model_identity?: {
          status?: string;
          provider_reported_models?: string[];
          invocations?: Array<{ provider_reported_model?: string }>;
        };
      };
    };
    const expectedModel =
      testCase.expectedStatus === "complete" ? "deepseek-v4-flash" : "ultrafuzz-provider-identity-mixed";
    assert.equal(metadata.accounting?.model_identity?.status, testCase.expectedStatus, testCase.label);
    assert.deepEqual(metadata.accounting?.model_identity?.provider_reported_models, [expectedModel], testCase.label);
    assert.equal(
      metadata.accounting?.model_identity?.invocations?.[0]?.provider_reported_model,
      expectedModel,
      testCase.label
    );
    const usage = fs
      .readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { usage?: { model?: string } });
    assert.equal(usage[0]?.usage?.model, expectedModel, testCase.label);
  }
});

test("syncRun preserves an unmatched invocation and recovers when delayed usage arrives", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-delayed-deepseek-usage";
  const startedEvents = workflowEvents(workflowRunId, [
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } }
  ]);
  const lifecycleEvents = workflowEvents(workflowRunId, [
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
    { type: "RunFinished" }
  ]);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: startedEvents,
    tokenEvents: ""
  });
  const pricingCatalog = {
    deepseek: {
      models: {
        "deepseek-v4-flash": {
          cost: { input: 0.14, cache_read: 0.0028, output: 0.28, reasoning: 0.28 }
        }
      }
    }
  };
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl(pricingCatalog);
  const run = await startRun({
    projectRoot: project,
    runId: "delayed-deepseek-usage",
    agent: "DeepSeekAgent",
    model: "deepseek-v4-flash",
    env
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const first = await syncRun({ projectRoot: project, runId: "delayed-deepseek-usage", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  const metadataPath = path.join(run.value!.run_root, "run.json");
  const readAccounting = () =>
    (
      JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        accounting?: {
          current?: { event_count?: number };
          cumulative?: { event_count?: number };
          model_identity?: { status?: string; invocation_count?: number };
          outstanding_model_invocations?: Array<{
            node_id?: string;
            iteration?: number;
            attempt?: number;
            terminal_evidence_complete?: boolean;
          }>;
        };
      }
    ).accounting;
  assert.equal(readAccounting()?.current?.event_count, 0);
  assert.equal(readAccounting()?.model_identity?.status, "incomplete");
  assert.equal(readAccounting()?.model_identity?.invocation_count, 1);
  assert.deepEqual(readAccounting()?.outstanding_model_invocations, [
    {
      ...readAccounting()?.outstanding_model_invocations?.[0],
      node_id: "node:project-discovery",
      iteration: 0,
      attempt: 1,
      terminal_evidence_complete: false
    }
  ]);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8"), "");

  // This changes only internal lifecycle closure details; the public identity
  // tuple and its incomplete status remain the same and must not suppress the
  // durable run.json update.
  fs.writeFileSync(env.SMITHERS_FAKE_EVENTS!, lifecycleEvents, "utf8");
  const terminal = await syncRun({ projectRoot: project, runId: "delayed-deepseek-usage", env });
  assert.equal(terminal.ok, true, JSON.stringify(terminal.diagnostics));
  assert.equal(readAccounting()?.model_identity?.status, "incomplete");
  assert.equal(readAccounting()?.outstanding_model_invocations?.[0]?.terminal_evidence_complete, true);

  // Simulate a lifecycle endpoint that no longer returns the completed event.
  // The full outstanding record in run.json must keep the invocation open.
  fs.writeFileSync(env.SMITHERS_FAKE_EVENTS!, "", "utf8");
  const withoutLifecycle = await syncRun({ projectRoot: project, runId: "delayed-deepseek-usage", env });
  assert.equal(withoutLifecycle.ok, true, JSON.stringify(withoutLifecycle.diagnostics));
  assert.equal(readAccounting()?.model_identity?.status, "incomplete");
  assert.equal(readAccounting()?.model_identity?.invocation_count, 1);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8"), "");

  fs.writeFileSync(
    env.SMITHERS_FAKE_TOKEN_EVENTS!,
    workflowEvents(workflowRunId, [
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          model: "deepseek-v4-flash",
          agent: "DeepSeekAgent"
        }
      }
    ]),
    "utf8"
  );
  const recovered = await syncRun({ projectRoot: project, runId: "delayed-deepseek-usage", env });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
  assert.equal(readAccounting()?.model_identity?.status, "complete");
  assert.equal(readAccounting()?.model_identity?.invocation_count, 1);
  assert.equal(readAccounting()?.current?.event_count, 1);
  assert.equal(readAccounting()?.cumulative?.event_count, 1);
  assert.deepEqual(readAccounting()?.outstanding_model_invocations, []);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8").trim().split("\n").length, 1);

  const corruptedMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    accounting: { outstanding_model_invocations: unknown[] };
  };
  corruptedMetadata.accounting.outstanding_model_invocations = [{}];
  fs.writeFileSync(metadataPath, `${JSON.stringify(corruptedMetadata, null, 2)}\n`, "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_TOKEN_EVENTS!, "", "utf8");
  const malformedReplay = await syncRun({ projectRoot: project, runId: "delayed-deepseek-usage", env });
  assert.equal(malformedReplay.ok, true, JSON.stringify(malformedReplay.diagnostics));
  assert.equal(readAccounting()?.model_identity?.status, "invalid");
  assert.equal(readAccounting()?.model_identity?.invocation_count, 2);
  assert.equal(readAccounting()?.outstanding_model_invocations?.length, 1);
});

test("syncRun retires a token-first sentinel when matching lifecycle evidence arrives", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-token-first-usage";
  const tokenEvent = {
    type: "TokenUsageReported",
    nodeId: "node:project-discovery",
    attempt: 1,
    sequence: 1,
    timestampMs: Date.parse("2026-07-03T00:00:00.100Z"),
    extra: {
      iteration: 0,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
      model: "gpt-test",
      agent: "codex"
    }
  };
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: "",
    tokenEvents: workflowEvents(workflowRunId, [tokenEvent])
  });
  const run = await startRun({ projectRoot: project, runId: "token-first-usage", model: "gpt-test", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const metadataPath = path.join(run.value!.run_root, "run.json");
  const readAccounting = () =>
    (
      JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        accounting?: {
          current?: { event_count?: number };
          cumulative?: { event_count?: number };
          model_identity?: { status?: string; invocation_count?: number };
          outstanding_model_invocations?: unknown[];
        };
      }
    ).accounting;

  const tokenFirst = await syncRun({ projectRoot: project, runId: "token-first-usage", env });
  assert.equal(tokenFirst.ok, true, JSON.stringify(tokenFirst.diagnostics));
  assert.equal(readAccounting()?.current?.event_count, 0);
  assert.equal(readAccounting()?.model_identity?.status, "incomplete");
  assert.equal(readAccounting()?.model_identity?.invocation_count, 1);
  assert.equal(readAccounting()?.outstanding_model_invocations?.length, 1);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8"), "");

  fs.writeFileSync(
    env.SMITHERS_FAKE_EVENTS!,
    workflowEvents(workflowRunId, [
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 0,
        timestampMs: Date.parse("2026-07-03T00:00:00.000Z"),
        extra: { iteration: 0 }
      },
      tokenEvent,
      {
        type: "NodeFinished",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 2,
        timestampMs: Date.parse("2026-07-03T00:00:00.200Z"),
        extra: { iteration: 0 }
      },
      { type: "RunFinished", sequence: 3, timestampMs: Date.parse("2026-07-03T00:00:00.300Z") }
    ]),
    "utf8"
  );
  const recovered = await syncRun({ projectRoot: project, runId: "token-first-usage", env });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
  const replayed = await syncRun({ projectRoot: project, runId: "token-first-usage", env });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.equal(readAccounting()?.current?.event_count, 1);
  assert.equal(readAccounting()?.cumulative?.event_count, 1);
  assert.equal(readAccounting()?.model_identity?.status, "complete");
  assert.equal(readAccounting()?.model_identity?.invocation_count, 1);
  assert.deepEqual(readAccounting()?.outstanding_model_invocations, []);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("syncRun assigns unique invocation identities to repeated lifecycle attempts", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-repeated-deepseek-invocations";
  const usage = (inputTokens: number, outputTokens: number) => ({
    type: "TokenUsageReported" as const,
    nodeId: "node:project-discovery",
    attempt: 1,
    extra: {
      iteration: 0,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      model: "deepseek-v4-flash",
      agent: "DeepSeekAgent"
    }
  });
  const events = workflowEvents(workflowRunId, [
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
    usage(10, 5),
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
    usage(20, 10),
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
    { type: "RunFinished" }
  ]);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    deepseek: {
      models: {
        "deepseek-v4-flash": {
          cost: { input: 0.14, cache_read: 0.0028, output: 0.28, reasoning: 0.28 }
        }
      }
    }
  });
  const run = await startRun({
    projectRoot: project,
    runId: "repeated-deepseek-invocations",
    agent: "DeepSeekAgent",
    model: "deepseek-v4-flash",
    env
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "repeated-deepseek-invocations", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const accounting = (
    JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
      accounting?: {
        current?: { event_count?: number };
        cumulative?: { event_count?: number };
        model_identity?: {
          status?: string;
          invocation_count?: number;
          invocations?: Array<{ invocation_id?: string }>;
        };
      };
    }
  ).accounting;
  const invocationIds = accounting?.model_identity?.invocations?.map((invocation) => invocation.invocation_id) ?? [];
  assert.equal(accounting?.model_identity?.status, "complete");
  assert.equal(accounting?.model_identity?.invocation_count, 2);
  assert.equal(accounting?.current?.event_count, 2);
  assert.equal(accounting?.cumulative?.event_count, 2);
  assert.equal(new Set(invocationIds).size, 2);
});

const MOONSHOT_KIMI_CATALOG = {
  moonshotai: {
    models: {
      "kimi-k3": { cost: { input: 3, output: 15, cache_read: 0.3 } }
    }
  }
};

function kimiTokenUsageEvents(workflowRunId: string): string {
  return workflowEvents(workflowRunId, [
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
    {
      type: "TokenUsageReported",
      nodeId: "node:project-discovery",
      attempt: 1,
      extra: {
        iteration: 0,
        // Kimi wire components map 1:1 onto Ultrafuzz's independent components.
        inputTokens: 120_000,
        outputTokens: 8_000,
        cacheReadTokens: 400_000,
        cacheWriteTokens: 20_000,
        model: "kimi-k3",
        agent: "KimiAgent"
      }
    },
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
    { type: "RunFinished" }
  ]);
}

test("syncRun publishes durable Kimi accounting and API-comparison cost at Moonshot rates", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-kimi-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: kimiTokenUsageEvents(workflowRunId)
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl(MOONSHOT_KIMI_CATALOG);
  const run = await startRun({ projectRoot: project, runId: "kimi-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "kimi-accounting", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));

  type KimiAccountingSegment = {
    uncached_input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    reasoning_tokens?: number;
    inclusive_token_total?: number;
    billable_token_total?: number;
    total_tokens?: number;
    estimated_spend?: string;
    estimated_spend_usd?: number;
    component_costs_usd?: Record<string, number>;
    usage_complete?: boolean;
    pricing_complete?: boolean;
    partial_pricing?: boolean;
    pricing_incomplete_reasons?: Array<{ code?: string; component?: string; model?: string }>;
    usage_incomplete_reasons?: unknown[];
    models?: string[];
    agents?: string[];
    event_count?: number;
  };
  const readAccounting = (): {
    current?: KimiAccountingSegment;
    cumulative?: KimiAccountingSegment;
    pricing_catalog?: { resolved_models?: string[]; unresolved_models?: string[] };
    updated_at?: string;
  } =>
    (
      JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
        accounting?: {
          current?: KimiAccountingSegment;
          cumulative?: KimiAccountingSegment;
          pricing_catalog?: { resolved_models?: string[]; unresolved_models?: string[] };
          updated_at?: string;
        };
      }
    ).accounting ?? {};

  const accounting = readAccounting();
  for (const segment of [accounting.current, accounting.cumulative]) {
    assert.ok(segment);
    // The four Kimi components stay independent through the durable ledger.
    assert.equal(segment.uncached_input_tokens, 120_000);
    assert.equal(segment.output_tokens, 8_000);
    assert.equal(segment.cache_read_tokens, 400_000);
    assert.equal(segment.cache_write_tokens, 20_000);
    assert.equal(segment.reasoning_tokens, 0);
    assert.equal(segment.inclusive_token_total, 548_000);
    assert.equal(segment.billable_token_total, 528_000);
    assert.equal(segment.total_tokens, 548_000);
    assert.equal(segment.usage_complete, true);
    assert.deepEqual(segment.usage_incomplete_reasons, []);
    assert.equal(segment.estimated_spend_usd, 0.6);
    assert.notEqual(segment.estimated_spend_usd, null);
    assert.deepEqual(segment.component_costs_usd, {
      uncached_input: 0.36,
      cache_read: 0.12,
      cache_write: 0,
      output: 0.12,
      reasoning: 0
    });
    // Cost is populated; pricing is partial only because the Moonshot catalog
    // entry carries no cache-write rate.
    assert.equal(segment.pricing_complete, false);
    assert.equal(segment.partial_pricing, true);
    assert.deepEqual(segment.pricing_incomplete_reasons, [
      { code: "component-rate-unavailable", component: "cache_write", model: "kimi-k3" }
    ]);
    assert.deepEqual(segment.models, ["kimi-k3"]);
    assert.deepEqual(segment.agents, ["KimiAgent"]);
  }
  assert.equal(accounting.current?.estimated_spend, "$0.60+");
  assert.deepEqual(accounting.pricing_catalog?.resolved_models, ["kimi-k3"]);
  assert.deepEqual(accounting.pricing_catalog?.unresolved_models, []);

  const resync = await syncRun({ projectRoot: project, runId: "kimi-accounting", env });
  assert.equal(resync.ok, true, JSON.stringify(resync.diagnostics));
  const resynced = readAccounting();
  assert.deepEqual(resynced.current, accounting.current);
  assert.deepEqual(resynced.cumulative, accounting.cumulative);
  assert.equal(resynced.updated_at, accounting.updated_at);
  assert.equal(resynced.cumulative?.event_count, accounting.cumulative?.event_count);
});

test("syncRun prices Kimi models from Moonshot, not an alphabetically earlier same-name provider", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-kimi-provider-pin";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "kimi-k3",
          agent: "KimiAgent"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    aihubmix: {
      models: {
        "kimi-k3": { cost: { input: 30, output: 150, cache_read: 3 } }
      }
    },
    ...MOONSHOT_KIMI_CATALOG,
    venice: {
      models: {
        "kimi-k3": { cost: { input: 3.75, output: 18.75 } }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "kimi-provider-pin", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "kimi-provider-pin", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: { estimated_spend?: string; estimated_spend_usd?: number; partial_pricing?: boolean };
      pricing_catalog?: { model_prices?: Record<string, { inputUsdPerMillion?: number }> };
    };
  };
  // 1M uncached input at $3 plus 100k output at $15 — the Moonshot rates.
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, 4.5);
  assert.equal(metadata.accounting?.current?.estimated_spend, "$4.50");
  assert.equal(metadata.accounting?.current?.partial_pricing, false);
  assert.equal(metadata.accounting?.pricing_catalog?.model_prices?.["kimi-k3"]?.inputUsdPerMillion, 3);
});

test("syncRun leaves a Kimi model unpriced when Moonshot does not list it", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-kimi-unresolved";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: kimiTokenUsageEvents(workflowRunId)
  });
  // Only non-Moonshot providers list the alias; borrowing their rate would
  // publish a silently wrong cost, so the model must stay unresolved.
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    crof: { models: { "kimi-k3": { cost: { input: 2, output: 8, cache_read: 0.25 } } } },
    kenari: { models: { "kimi-k3": { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } } },
    moonshotai: { models: { "kimi-k2.6": { cost: { input: 0.95, output: 4, cache_read: 0.16 } } } }
  });
  const run = await startRun({ projectRoot: project, runId: "kimi-unresolved", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "kimi-unresolved", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        total_tokens?: number;
        estimated_spend?: string;
        estimated_spend_usd?: number;
        usage_complete?: boolean;
        pricing_incomplete_reasons?: Array<{ code?: string }>;
      };
      pricing_catalog?: { resolved_models?: string[]; unresolved_models?: string[] };
    };
  };
  assert.deepEqual(metadata.accounting?.pricing_catalog?.resolved_models, []);
  assert.deepEqual(metadata.accounting?.pricing_catalog?.unresolved_models, ["kimi-k3"]);
  assert.equal(metadata.accounting?.current?.total_tokens, 548_000);
  assert.equal(metadata.accounting?.current?.usage_complete, true);
  assert.equal(metadata.accounting?.current?.estimated_spend, "unavailable");
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, undefined);
  assert.ok(
    metadata.accounting?.current?.pricing_incomplete_reasons?.every(
      (reason) => reason.code === "model-pricing-unavailable"
    )
  );
});

test("syncRun does not assume zero cache reads when cache telemetry is missing", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-unknown-cache-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 100_000,
          outputTokens: 10_000,
          model: "gpt-5.6-sol",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-5.6-sol": { cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 } }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "unknown-cache-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "unknown-cache-accounting", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        estimated_spend?: string;
        usage_complete?: boolean;
        usage_incomplete_reasons?: Array<{ code?: string; component?: string; model?: string }>;
        pricing_complete?: boolean;
        partial_pricing?: boolean;
        priced_event_count?: number;
        unpriced_event_count?: number;
        cache_read_pricing_estimated?: boolean;
      };
    };
  };
  assert.equal(metadata.accounting?.current?.estimated_spend, "unavailable");
  assert.equal(metadata.accounting?.current?.usage_complete, false);
  assert.deepEqual(metadata.accounting?.current?.usage_incomplete_reasons, [
    {
      code: "component-usage-unavailable",
      component: "cache_read",
      model: "gpt-5.6-sol"
    }
  ]);
  assert.equal(metadata.accounting?.current?.pricing_complete, true);
  assert.equal(metadata.accounting?.current?.partial_pricing, false);
  assert.equal(metadata.accounting?.current?.priced_event_count, 1);
  assert.equal(metadata.accounting?.current?.unpriced_event_count, 0);
  assert.equal(metadata.accounting?.current?.cache_read_pricing_estimated, false);
});

test("syncRun can price missing cache telemetry with an evidence-based cache ratio", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-estimated-cache-accounting";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 100_000,
          outputTokens: 10_000,
          model: "gpt-5.6-sol",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-5.6-sol": { cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 } }
      }
    }
  });
  env.ULTRAFUZZ_CACHE_READ_RATIO = "0.9";
  const run = await startRun({ projectRoot: project, runId: "estimated-cache-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "estimated-cache-accounting", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        estimated_spend?: string;
        inclusive_token_total?: number;
        usage_complete?: boolean;
        usage_incomplete_reasons?: Array<{ code?: string; component?: string; model?: string }>;
        pricing_complete?: boolean;
        partial_pricing?: boolean;
        priced_event_count?: number;
        unpriced_event_count?: number;
        cache_read_pricing_estimated?: boolean;
        cache_read_ratio_used?: number;
      };
    };
  };
  assert.equal(metadata.accounting?.current?.estimated_spend, "$0.84");
  assert.equal(metadata.accounting?.current?.inclusive_token_total, 200_000);
  assert.equal(metadata.accounting?.current?.usage_complete, false);
  assert.deepEqual(metadata.accounting?.current?.usage_incomplete_reasons, [
    {
      code: "component-usage-estimated",
      component: "cache_read",
      model: "gpt-5.6-sol"
    }
  ]);
  assert.equal(metadata.accounting?.current?.pricing_complete, true);
  assert.equal(metadata.accounting?.current?.partial_pricing, false);
  assert.equal(metadata.accounting?.current?.priced_event_count, 1);
  assert.equal(metadata.accounting?.current?.unpriced_event_count, 0);
  assert.equal(metadata.accounting?.current?.cache_read_pricing_estimated, true);
  assert.equal(metadata.accounting?.current?.cache_read_ratio_used, 0.9);
});

test("getRunStatus synchronizes without appending duplicate events", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-inspect-idempotent";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "inspect-idempotent", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const first = await getRunStatus({ projectRoot: project, runId: "inspect-idempotent", env });
  const second = await getRunStatus({ projectRoot: project, runId: "inspect-idempotent", env });

  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  assert.equal(first.value?.status, "succeeded");
  assert.equal(second.value?.status, "succeeded");
  assert.equal(second.value?.events, first.value?.events);
});

test("syncRun fails a successful workflow node with missing artifacts and rejects late injection for that retry", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-missing";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-missing", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-missing", env });

  assert.equal(sync.ok, true);
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "VERIFIER_RECEIPT_OUTPUT_INVALID"));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      {
        status?: string;
        last_error?: string;
        provenance?: {
          failure?: { category?: string; causal_task_id?: string; causal_failure_category?: string };
          terminal_disposition?: unknown;
        };
      }
    >;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.deepEqual(state.nodes?.["project-discovery"]?.provenance?.failure, {
    category: "artifact-contract",
    causal_task_id: "verify:project-discovery",
    causal_failure_category: "artifact-contract",
    dependent_task_ids: []
  });
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.terminal_disposition, undefined);
  assert.equal((await terminalDispositionForRunRoot(run.value!.run_root)).kind, "operational-failure");

  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const repaired = await syncRun(
    { projectRoot: project, runId: "sync-missing", env },
    { now: () => Date.parse("2026-07-03T00:06:00.000Z") }
  );
  assert.equal(repaired.ok, true, JSON.stringify(repaired.diagnostics));
  assert.equal(repaired.value?.status, "failed");
  assert.ok(repaired.diagnostics.some((diagnostic) => diagnostic.code === "VERIFIER_RECEIPT_OUTPUT_INVALID"));
  const repairedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; last_error?: string }>;
  };
  assert.equal(repairedState.nodes?.["project-discovery"]?.status, "failed");
  assert.match(
    repairedState.nodes?.["project-discovery"]?.last_error ?? "",
    /executor retry already has a non-successful ledger outcome/u
  );
  const attempts = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { outcome?: string });
  assert.deepEqual(
    attempts.map((attempt) => attempt.outcome),
    ["failed"]
  );
});

test("syncRun reconciles exact task-workspace artifact mirrors before strict validation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-reconciled";
  const runnerOverrides = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-reconciled", env: runnerOverrides });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const mirrorRoot = path.join(
    run.value!.run_root,
    "workspaces",
    "project-discovery",
    "artifacts",
    "project-discovery"
  );
  writeRequiredArtifactSet(path.dirname(path.dirname(mirrorRoot)), "project-discovery", [
    "setup/project-discovery.md",
    "findings.json"
  ]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-reconciled", env: runnerOverrides });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "setup", "project-discovery.md")),
    true
  );
  assert.match(fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8"), /node-artifacts-reconciled/);
});

test("syncRun starts artifact grace from the refreshed post-inspection clock", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-refreshed-clock";
  const inspectionMarker = path.join(project, "inspection-completed");
  const env = fakeLifecycleSmithersEnv(project, {
    allowMissingVerifierArtifacts: true,
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ]),
    inspectMarkerPath: inspectionMarker
  });
  const run = await startRun({ projectRoot: project, runId: "sync-refreshed-clock", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const beforeInspection = Date.parse("2026-07-03T00:01:10.000Z");
  const afterInspection = beforeInspection + 120_000;
  const pending = await syncRun(
    { projectRoot: project, runId: "sync-refreshed-clock", env },
    { now: () => (fs.existsSync(inspectionMarker) ? afterInspection : beforeInspection) }
  );
  assert.equal(pending.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { provenance?: { artifact_reconciliation_grace?: { started_at?: string } } }>;
  };
  assert.equal(
    state.nodes?.["project-discovery"]?.provenance?.artifact_reconciliation_grace?.started_at,
    new Date(afterInspection).toISOString()
  );
});

test("syncRun fails closed for semantically invalid persisted artifact grace", async () => {
  const variants: Array<{ label: string; mutate: (grace: Record<string, unknown>) => void }> = [
    {
      label: "oversized-deadline",
      mutate: (grace) => {
        grace.deadline_at = new Date(
          Date.parse(String(grace.started_at)) + ARTIFACT_RECONCILIATION_GRACE_MS + 1
        ).toISOString();
      }
    },
    {
      label: "unordered-last-attempt",
      mutate: (grace) => {
        grace.last_attempt_at = new Date(Date.parse(String(grace.started_at)) - 1).toISOString();
      }
    },
    {
      label: "attempt-overflow",
      mutate: (grace) => {
        grace.attempts = ARTIFACT_RECONCILIATION_MAX_ATTEMPTS + 1;
      }
    },
    {
      label: "future-window",
      mutate: (grace) => {
        const futureStartedAt =
          Date.parse("2026-07-03T00:01:20.000Z") +
          ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS +
          ARTIFACT_RECONCILIATION_CLOCK_SKEW_MS +
          1;
        grace.started_at = new Date(futureStartedAt).toISOString();
        grace.last_attempt_at = new Date(futureStartedAt).toISOString();
        grace.deadline_at = new Date(futureStartedAt + ARTIFACT_RECONCILIATION_GRACE_MS).toISOString();
      }
    }
  ];
  for (const variant of variants) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const workflowRunId = `ultrafuzz-sync-grace-${variant.label}`;
    const runId = `sync-grace-${variant.label}`;
    const env = fakeLifecycleSmithersEnv(project, {
      allowMissingVerifierArtifacts: true,
      inspect: workflowInspect({
        workflowRunId,
        steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
      }),
      events: workflowEvents(workflowRunId, [
        { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
        { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
        { type: "RunFinished" }
      ])
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const now = Date.parse("2026-07-03T00:01:20.000Z");
    const pending = await syncRun({ projectRoot: project, runId, env }, { now: () => now });
    assert.equal(pending.value?.status, "running");
    const statePath = path.join(run.value!.run_root, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      nodes: Record<string, { provenance: { artifact_reconciliation_grace: Record<string, unknown> } }>;
    };
    variant.mutate(state.nodes["project-discovery"]!.provenance.artifact_reconciliation_grace);
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const rejected = await syncRun(
      { projectRoot: project, runId, env },
      { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
    );
    assert.equal(rejected.value?.status, "failed", variant.label);
    assert.ok(rejected.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_MISSING"));
    assert.equal(
      rejected.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"),
      false
    );
  }
});

test("syncRun stops artifact reconciliation at the retry bound before the grace deadline", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-retry-bound";
  const env = fakeLifecycleSmithersEnv(project, {
    allowMissingVerifierArtifacts: true,
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-retry-bound", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const startedAt = Date.parse("2026-07-03T00:01:30.000Z");

  for (let attempt = 1; attempt < ARTIFACT_RECONCILIATION_MAX_ATTEMPTS; attempt += 1) {
    const pending = await syncRun(
      { projectRoot: project, runId: "sync-retry-bound", env },
      { now: () => startedAt + (attempt - 1) * ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
    );
    assert.equal(pending.value?.status, "running", `attempt ${attempt}`);
    assert.ok(pending.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"));
  }

  const bounded = await syncRun(
    { projectRoot: project, runId: "sync-retry-bound", env },
    {
      now: () => startedAt + (ARTIFACT_RECONCILIATION_MAX_ATTEMPTS - 1) * ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS
    }
  );
  assert.ok(
    (ARTIFACT_RECONCILIATION_MAX_ATTEMPTS - 1) * ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS <
      ARTIFACT_RECONCILIATION_GRACE_MS
  );
  assert.equal(bounded.value?.status, "failed");
  assert.ok(bounded.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_MISSING"));
  assert.equal(
    bounded.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"),
    false
  );
});

test("syncRun keeps a strict node pending until a late safe mirror is reconciled once", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-late-mirror";
  const env = fakeLifecycleSmithersEnv(project, {
    allowMissingVerifierArtifacts: true,
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-late-mirror", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const now = Date.parse("2026-07-03T00:02:00.000Z");

  const pending = await syncRun({ projectRoot: project, runId: "sync-late-mirror", env }, { now: () => now });
  assert.equal(pending.ok, true, JSON.stringify(pending.diagnostics));
  assert.equal(pending.value?.status, "running");
  assert.ok(pending.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"));

  const mirrorRoot = path.join(
    run.value!.run_root,
    "workspaces",
    "project-discovery",
    "artifacts",
    "project-discovery"
  );
  writeRequiredArtifactSet(path.dirname(path.dirname(mirrorRoot)), "project-discovery", [
    "setup/project-discovery.md",
    "findings.json"
  ]);

  const completed = await syncRun(
    { projectRoot: project, runId: "sync-late-mirror", env },
    { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
  );
  assert.equal(completed.ok, true, JSON.stringify(completed.diagnostics));
  assert.equal(completed.value?.status, "succeeded");
  const eventsPath = path.join(run.value!.run_root, "events.jsonl");
  const beforeRepeat = fs.readFileSync(eventsPath, "utf8");
  assert.equal((beforeRepeat.match(/node-artifacts-reconciled/gu) ?? []).length, 1);
  assert.equal((beforeRepeat.match(/node-artifact-reconciliation-grace-completed/gu) ?? []).length, 1);
  assert.equal((beforeRepeat.match(/node-artifacts-verified/gu) ?? []).length, 1);
  assert.equal((beforeRepeat.match(/node-artifacts-missing/gu) ?? []).length, 0);

  const repeated = await syncRun(
    { projectRoot: project, runId: "sync-late-mirror", env },
    { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS * 2 }
  );
  assert.equal(repeated.ok, true, JSON.stringify(repeated.diagnostics));
  assert.equal(fs.readFileSync(eventsPath, "utf8"), beforeRepeat);
});

test("syncRun retries same-inode regular-file growth during artifact grace", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-growing-mirror";
  const env = fakeLifecycleSmithersEnv(project, {
    allowMissingVerifierArtifacts: true,
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-growing-mirror", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const now = Date.parse("2026-07-03T00:02:30.000Z");
  const pending = await syncRun({ projectRoot: project, runId: "sync-growing-mirror", env }, { now: () => now });
  assert.equal(pending.value?.status, "running");
  const mirrorRoot = path.join(
    run.value!.run_root,
    "workspaces",
    "project-discovery",
    "artifacts",
    "project-discovery"
  );
  writeRequiredArtifactSet(path.dirname(path.dirname(mirrorRoot)), "project-discovery", [
    "setup/project-discovery.md",
    "findings.json"
  ]);
  const source = path.join(mirrorRoot, "setup", "project-discovery.md");
  const originalReadSync = fs.readSync;
  let grew = false;
  fs.readSync = ((fd, buffer, offset, length, position) => {
    const bytesRead = originalReadSync(fd, buffer, offset, length, position);
    if (!grew && bytesRead > 0 && fs.realpathSync(`/proc/self/fd/${fd}`) === source) {
      grew = true;
      fs.appendFileSync(source, "late growth\n", "utf8");
    }
    return bytesRead;
  }) as typeof fs.readSync;
  let retryable;
  try {
    retryable = await syncRun(
      { projectRoot: project, runId: "sync-growing-mirror", env },
      { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
    );
  } finally {
    fs.readSync = originalReadSync;
  }
  assert.equal(grew, true);
  assert.equal(retryable.value?.status, "running");
  assert.ok(retryable.diagnostics.some((diagnostic) => diagnostic.code === "WORKSPACE_ARTIFACT_RECONCILE_RETRYABLE"));
  assert.ok(retryable.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"));
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "setup", "project-discovery.md")),
    false
  );

  const completed = await syncRun(
    { projectRoot: project, runId: "sync-growing-mirror", env },
    { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS * 2 }
  );
  assert.equal(completed.value?.status, "succeeded", JSON.stringify(completed.diagnostics));
});

test("syncRun rejects a regular-file inode replacement during artifact grace", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-replaced-mirror";
  const env = fakeLifecycleSmithersEnv(project, {
    allowMissingVerifierArtifacts: true,
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-replaced-mirror", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const now = Date.parse("2026-07-03T00:02:45.000Z");
  const pending = await syncRun({ projectRoot: project, runId: "sync-replaced-mirror", env }, { now: () => now });
  assert.equal(pending.value?.status, "running");
  const mirrorRoot = path.join(
    run.value!.run_root,
    "workspaces",
    "project-discovery",
    "artifacts",
    "project-discovery"
  );
  writeRequiredArtifactSet(path.dirname(path.dirname(mirrorRoot)), "project-discovery", [
    "setup/project-discovery.md",
    "findings.json"
  ]);
  const source = path.join(mirrorRoot, "setup", "project-discovery.md");
  const preserved = `${source}.preserved`;
  const originalOpenSync = fs.openSync;
  let replaced = false;
  fs.openSync = ((filePath, flags, mode) => {
    if (!replaced && String(filePath) === source) {
      replaced = true;
      fs.renameSync(source, preserved);
      fs.writeFileSync(source, "replacement regular file\n", "utf8");
    }
    return originalOpenSync(filePath, flags, mode);
  }) as typeof fs.openSync;
  let rejected;
  try {
    rejected = await syncRun(
      { projectRoot: project, runId: "sync-replaced-mirror", env },
      { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(source, { force: true });
    fs.renameSync(preserved, source);
  }
  assert.equal(replaced, true);
  assert.equal(rejected.value?.status, "failed");
  assert.ok(
    rejected.diagnostics.some(
      (diagnostic) => diagnostic.source === "artifact-reconciliation" && diagnostic.severity === "error"
    )
  );
  assert.equal(
    rejected.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"),
    false
  );
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "setup", "project-discovery.md")),
    false
  );
});

test("syncRun rejects unsafe late mirrors instead of extending artifact grace", async () => {
  for (const sourceKind of ["symlink", "hardlink"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const workflowRunId = `ultrafuzz-sync-unsafe-${sourceKind}`;
    const env = fakeLifecycleSmithersEnv(project, {
      allowMissingVerifierArtifacts: true,
      inspect: workflowInspect({
        workflowRunId,
        steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
      }),
      events: workflowEvents(workflowRunId, [
        { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
        { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
        { type: "RunFinished" }
      ])
    });
    const run = await startRun({ projectRoot: project, runId: `sync-unsafe-${sourceKind}`, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const now = Date.parse("2026-07-03T00:03:00.000Z");
    const pending = await syncRun(
      { projectRoot: project, runId: `sync-unsafe-${sourceKind}`, env },
      { now: () => now }
    );
    assert.equal(pending.value?.status, "running");

    const mirrorRoot = path.join(
      run.value!.run_root,
      "workspaces",
      "project-discovery",
      "artifacts",
      "project-discovery"
    );
    fs.mkdirSync(path.join(mirrorRoot, "setup"), { recursive: true });
    const outside = path.join(project, `${sourceKind}-outside.md`);
    fs.writeFileSync(outside, "unsafe source\n", "utf8");
    const source = path.join(mirrorRoot, "setup", "project-discovery.md");
    if (sourceKind === "symlink") {
      fs.symlinkSync(outside, source);
    } else {
      fs.linkSync(outside, source);
    }

    const rejected = await syncRun(
      { projectRoot: project, runId: `sync-unsafe-${sourceKind}`, env },
      { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
    );
    assert.equal(rejected.ok, true);
    assert.equal(rejected.value?.status, "failed");
    assert.ok(
      rejected.diagnostics.some(
        (diagnostic) => diagnostic.source === "artifact-reconciliation" && diagnostic.severity === "error"
      )
    );
    assert.equal(
      rejected.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"),
      false
    );
    assert.equal(
      fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "setup", "project-discovery.md")),
      false
    );
  }
});

test("syncRun rejects a late mirror source swap during artifact grace", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-raced-mirror";
  const env = fakeLifecycleSmithersEnv(project, {
    allowMissingVerifierArtifacts: true,
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-raced-mirror", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const now = Date.parse("2026-07-03T00:03:30.000Z");
  const pending = await syncRun({ projectRoot: project, runId: "sync-raced-mirror", env }, { now: () => now });
  assert.equal(pending.value?.status, "running");

  const mirrorRoot = path.join(
    run.value!.run_root,
    "workspaces",
    "project-discovery",
    "artifacts",
    "project-discovery"
  );
  writeRequiredArtifactSet(path.dirname(path.dirname(mirrorRoot)), "project-discovery", [
    "setup/project-discovery.md",
    "findings.json"
  ]);
  const source = path.join(mirrorRoot, "setup", "project-discovery.md");
  const sourceDirectory = path.dirname(source);
  const preservedDirectory = path.join(mirrorRoot, "setup-preserved");
  const outsideDirectory = tempProject();
  fs.writeFileSync(path.join(outsideDirectory, "project-discovery.md"), "outside\n", "utf8");
  const originalOpenSync = fs.openSync;
  let swapped = false;
  fs.openSync = ((filePath, flags, mode) => {
    if (!swapped && String(filePath) === source) {
      swapped = true;
      fs.renameSync(sourceDirectory, preservedDirectory);
      fs.symlinkSync(outsideDirectory, sourceDirectory);
    }
    return originalOpenSync(filePath, flags, mode);
  }) as typeof fs.openSync;
  let rejected;
  try {
    rejected = await syncRun(
      { projectRoot: project, runId: "sync-raced-mirror", env },
      { now: () => now + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(sourceDirectory, { force: true });
    fs.renameSync(preservedDirectory, sourceDirectory);
  }
  assert.equal(swapped, true);
  assert.equal(rejected.ok, true);
  assert.equal(rejected.value?.status, "failed");
  assert.ok(
    rejected.diagnostics.some(
      (diagnostic) => diagnostic.source === "artifact-reconciliation" && diagnostic.severity === "error"
    )
  );
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "setup", "project-discovery.md")),
    false
  );
});

test("syncRun honors cancellation and an overall deadline before starting artifact grace", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-budget";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-budget", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const before = fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8");
  const now = Date.parse("2026-07-03T00:04:00.000Z");
  const controller = new AbortController();
  controller.abort();

  const cancelled = await syncRun(
    { projectRoot: project, runId: "sync-budget", env },
    { now: () => now, signal: controller.signal }
  );
  assert.equal(cancelled.ok, false);
  assert.ok(cancelled.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CANCELLED"));
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8"), before);

  const expired = await syncRun(
    { projectRoot: project, runId: "sync-budget", env },
    { now: () => now, deadlineMs: now }
  );
  assert.equal(expired.ok, false);
  assert.ok(expired.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED"));
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8"), before);

  let clockReads = 0;
  const expiredAfterInspection = await syncRun(
    { projectRoot: project, runId: "sync-budget", env },
    {
      now: () => now + clockReads++,
      deadlineMs: now + 1
    }
  );
  assert.equal(expiredAfterInspection.ok, false);
  assert.ok(
    expiredAfterInspection.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED")
  );
  assert.equal(clockReads, 3);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8"), before);
});

test("syncRun interrupts large reconciliation copies without publishing or mutating state and events", async () => {
  for (const mode of ["deadline", "abort"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const workflowRunId = `ultrafuzz-sync-large-copy-${mode}`;
    const runId = `sync-large-copy-${mode}`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId,
        steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
      }),
      events: workflowEvents(workflowRunId, [
        { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
        { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
        { type: "RunFinished" }
      ])
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const mirrorRoot = path.join(
      run.value!.run_root,
      "workspaces",
      "project-discovery",
      "artifacts",
      "project-discovery"
    );
    writeRequiredArtifactSet(path.dirname(path.dirname(mirrorRoot)), "project-discovery", [
      "setup/project-discovery.md",
      "findings.json"
    ]);
    const source = path.join(mirrorRoot, "setup", "project-discovery.md");
    fs.writeFileSync(source, Buffer.alloc(8 * 1024 * 1024, 0x61));

    const statePath = path.join(run.value!.run_root, "state.json");
    const eventsPath = path.join(run.value!.run_root, "events.jsonl");
    const stateBefore = fs.readFileSync(statePath, "utf8");
    const eventsBefore = fs.readFileSync(eventsPath, "utf8");
    const artifactDir = path.join(run.value!.run_root, "artifacts", "project-discovery");
    const destination = path.join(artifactDir, "setup", "project-discovery.md");
    const controller = new AbortController();
    const startedAt = Date.parse("2026-07-03T00:04:30.000Z");
    // Keep the real subprocess timeout comfortably above the fake Smithers startup cost;
    // the mocked clock crosses this deadline only after the first reconciliation read.
    const deadline = startedAt + 60_000;
    let currentTime = startedAt;
    let sourceReads = 0;
    let abortScheduled = false;
    const originalReadSync = fs.readSync;
    fs.readSync = ((fd, buffer, offset, length, position) => {
      const bytesRead = originalReadSync(fd, buffer, offset, length, position);
      let openedPath = "";
      try {
        openedPath = fs.realpathSync(`/proc/self/fd/${fd}`);
      } catch {
        // Ignore unrelated descriptors that close between read and inspection.
      }
      if (bytesRead > 0 && openedPath === source) {
        sourceReads += 1;
        if (mode === "deadline" && sourceReads === 1) {
          currentTime = deadline + 1;
        }
        if (mode === "abort" && !abortScheduled) {
          abortScheduled = true;
          setImmediate(() => controller.abort());
        }
      }
      return bytesRead;
    }) as typeof fs.readSync;

    let interrupted;
    try {
      interrupted = await syncRun(
        { projectRoot: project, runId, env },
        mode === "deadline"
          ? { now: () => currentTime, deadlineMs: deadline }
          : { now: () => currentTime, signal: controller.signal }
      );
    } finally {
      fs.readSync = originalReadSync;
    }

    assert.ok(sourceReads >= 1, `${mode}: sourceReads=${sourceReads}`);
    assert.equal(interrupted.ok, false, mode);
    assert.ok(
      interrupted.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === (mode === "deadline" ? "WORKFLOW_SYNC_DEADLINE_EXCEEDED" : "WORKFLOW_SYNC_CANCELLED")
      ),
      mode
    );
    assert.equal(fs.existsSync(destination), false, mode);
    assert.equal(
      fs.readdirSync(artifactDir, { recursive: true }).some((entry) => String(entry).includes(".reconcile-")),
      false,
      mode
    );
    assert.equal(fs.readFileSync(statePath, "utf8"), stateBefore, mode);
    assert.equal(fs.readFileSync(eventsPath, "utf8"), eventsBefore, mode);
  }
});

test("syncRun aborts or times out a blocked inspection child without durable mutation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const binDir = path.join(project, "blocked-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  const inspectStarted = path.join(project, "blocked-inspection-started");
  fs.writeFileSync(
    smithers,
    `#!${process.execPath}
import fs from "node:fs";
if (process.argv[2] === "inspect") {
  if (process.env.SMITHERS_TEST_INSPECT_STARTED) {
    fs.writeFileSync(process.env.SMITHERS_TEST_INSPECT_STARTED, "started\\n");
  }
  setInterval(() => {}, 1000);
} else {
  process.stdout.write('{"ok":true}\\n');
}
`,
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  const env = createSmithersTestEnvironment(smithers, {
    SMITHERS_TEST_INSPECT_STARTED: inspectStarted,
    ULTRAFUZZ_PRICING_CATALOG_URL: "off"
  });
  const run = await startRun({ projectRoot: project, runId: "sync-blocked-child", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const statePath = path.join(run.value!.run_root, "state.json");
  const before = fs.readFileSync(statePath, "utf8");

  const controller = new AbortController();
  const cancelledPromise = syncRun(
    { projectRoot: project, runId: "sync-blocked-child", env },
    { signal: controller.signal }
  );
  await waitForPath(inspectStarted);
  const abortStartedAt = Date.now();
  controller.abort();
  const cancelled = await cancelledPromise;
  assert.equal(cancelled.ok, false);
  assert.ok(cancelled.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CANCELLED"));
  assert.ok(Date.now() - abortStartedAt < 2_000);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);

  let deadlineStartedAt = 0;
  let deadlineAt = 0;
  const execution = await withLinkedWorkflowExecution(
    { projectRoot: project, runId: "sync-blocked-child", env },
    ({ synchronize }) => {
      deadlineStartedAt = Date.now();
      deadlineAt = deadlineStartedAt + 100;
      return synchronize({ deadlineMs: deadlineAt });
    },
    () => ({ timeoutMs: Math.max(0, deadlineAt - Date.now()) })
  );
  assert.equal(execution.ok, true, JSON.stringify(execution));
  const expired = execution.value;
  assert.equal(expired.ok, false);
  assert.ok(expired.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED"));
  assert.ok(Date.now() - deadlineStartedAt < 2_000);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
});

test("syncRun interruption during verifier output collection does not poison a successful retry", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-blocked-verifier-output";
  const workflowRunId = `ultrafuzz-${runId}`;
  const outputStarted = path.join(project, "verifier-output-started");
  const outputRelease = path.join(project, "verifier-output-release");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ]),
    outputStartedMarkerPath: outputStarted,
    outputReleaseMarkerPath: outputRelease
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const attemptsPath = path.join(run.value!.run_root, "attempts.jsonl");
  const attemptsBefore = fs.readFileSync(attemptsPath, "utf8");
  const controller = new AbortController();

  const interruptedPromise = syncRun({ projectRoot: project, runId, env }, { signal: controller.signal });
  let interrupted: Awaited<ReturnType<typeof syncRun>> | undefined;
  try {
    await waitForPath(outputStarted, 60_000);
    controller.abort();
    interrupted = await interruptedPromise;
  } finally {
    controller.abort();
    if (!fs.existsSync(outputRelease)) fs.writeFileSync(outputRelease, "release\n", "utf8");
    await interruptedPromise.catch(() => undefined);
  }
  assert.ok(interrupted);
  assert.equal(interrupted.ok, false, JSON.stringify(interrupted.diagnostics));
  assert.ok(interrupted.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CANCELLED"));
  assert.equal(fs.readFileSync(attemptsPath, "utf8"), attemptsBefore);

  const retried = await syncRun({ projectRoot: project, runId, env });
  assert.equal(retried.ok, true, JSON.stringify(retried.diagnostics));
  assert.equal(retried.value?.status, "succeeded");
  const attempts = fs
    .readFileSync(attemptsPath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { outcome?: string });
  assert.ok(attempts.length > 0);
  assert.ok(attempts.every((attempt) => attempt.outcome === "succeeded"));
});

test("syncRun cancellation and deadline bound workflow mutation lock acquisition", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-mutation-lock-budget";
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({ workflowRunId, status: "running", state: "running", steps: [] }),
    events: workflowEvents(workflowRunId, [])
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const statePath = path.join(run.value!.run_root, "state.json");
  const before = fs.readFileSync(statePath, "utf8");
  const release = await acquireWorkflowMutationLock(layoutForRunRoot(run.value!.run_root));
  try {
    const controller = new AbortController();
    let abortTimer: NodeJS.Timeout | undefined;
    const cancelled = await syncRun(
      { projectRoot: project, runId, env },
      {
        signal: controller.signal,
        beforeCommit: () => {
          abortTimer = setTimeout(() => controller.abort(), 50);
        }
      }
    );
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    assert.equal(cancelled.ok, false, JSON.stringify(cancelled.diagnostics));
    assert.ok(cancelled.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CANCELLED"));

    let lockWaitStartedAt = 0;
    const deadlineControl = {
      deadlineMs: Date.now() + 60_000,
      beforeCommit: () => {
        lockWaitStartedAt = Date.now();
        deadlineControl.deadlineMs = lockWaitStartedAt + 100;
      }
    };
    const expired = await syncRun({ projectRoot: project, runId, env }, deadlineControl);
    assert.equal(expired.ok, false, JSON.stringify(expired.diagnostics));
    assert.ok(expired.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED"));
    assert.ok(lockWaitStartedAt > 0);
    assert.ok(Date.now() - lockWaitStartedAt < 2_000);
    assert.equal(fs.readFileSync(statePath, "utf8"), before);
  } finally {
    await release();
  }
});

test("workflow mutation locks preserve fresh ownerless acquisitions for the full stale window", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const run = await startRun({
    projectRoot: project,
    runId: "fresh-ownerless-mutation-lock",
    env: fakeSmithersEnv(project)
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  const lockPath = path.join(layout.root, ".workflow-mutation");
  fs.mkdirSync(lockPath);

  await assert.rejects(
    acquireWorkflowMutationLock(layout, { timeoutMs: 50 }),
    /exceeded its synchronization deadline/u
  );
  assert.equal(fs.existsSync(lockPath), true);

  fs.utimesSync(lockPath, new Date(0), new Date(0));
  const release = await acquireWorkflowMutationLock(layout, { timeoutMs: 2_000 });
  await release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("syncRun finishes the node state-and-event commit unit when cancellation lands during the state write", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-node-local-commit";
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const statePath = path.join(run.value!.run_root, "state.json");
  const controller = new AbortController();
  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "renameSync")!;
  const originalRenameSync = fs.renameSync;
  let interruptedStateCommit = false;
  Object.defineProperty(fs, "renameSync", {
    ...originalDescriptor,
    value: ((source: fs.PathLike, destination: fs.PathLike) => {
      const result = originalRenameSync(source, destination);
      if (!interruptedStateCommit && path.resolve(String(destination)) === statePath) {
        interruptedStateCommit = true;
        controller.abort();
      }
      return result;
    }) as typeof fs.renameSync
  });
  let interrupted;
  try {
    interrupted = await syncRun({ projectRoot: project, runId, env }, { signal: controller.signal });
  } finally {
    Object.defineProperty(fs, "renameSync", originalDescriptor);
  }
  assert.equal(interruptedStateCommit, true);
  assert.equal(interrupted.ok, false, JSON.stringify(interrupted.diagnostics));
  assert.ok(interrupted.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CANCELLED"));
  const layout = layoutForRunRoot(run.value!.run_root);
  assert.equal(readRunState(layout).nodes["project-discovery"]?.status, "succeeded");
  const nodeEvents = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter(
    (event) => event.node_id === "project-discovery"
  );
  assert.ok(nodeEvents.some((event) => event.event_type === "node-synced"));
  assert.ok(nodeEvents.some((event) => event.event_type === "artifact-manifest-written"));

  const retried = await syncRun({ projectRoot: project, runId, env });
  assert.equal(retried.ok, true, JSON.stringify(retried.diagnostics));
  assert.equal(
    replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter(
      (event) => event.node_id === "project-discovery" && event.event_type === "node-synced"
    ).length,
    1
  );
});

test("syncRun finishes the final run state-and-event commit unit when cancellation lands during the state write", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-final-local-commit";
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const statePath = path.join(run.value!.run_root, "state.json");
  const controller = new AbortController();
  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "renameSync")!;
  const originalRenameSync = fs.renameSync;
  let interruptedFinalCommit = false;
  Object.defineProperty(fs, "renameSync", {
    ...originalDescriptor,
    value: ((source: fs.PathLike, destination: fs.PathLike) => {
      const result = originalRenameSync(source, destination);
      if (!interruptedFinalCommit && path.resolve(String(destination)) === statePath) {
        const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as { status?: string };
        if (persisted.status === "succeeded") {
          interruptedFinalCommit = true;
          controller.abort();
        }
      }
      return result;
    }) as typeof fs.renameSync
  });
  let synchronized;
  try {
    synchronized = await syncRun({ projectRoot: project, runId, env }, { signal: controller.signal });
  } finally {
    Object.defineProperty(fs, "renameSync", originalDescriptor);
  }
  assert.equal(interruptedFinalCommit, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(synchronized.ok, true, JSON.stringify(synchronized.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  assert.equal(readRunState(layout).status, "succeeded");
  assert.equal(
    replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter((event) => event.event_type === "workflow-synced")
      .length,
    1
  );
});

test("syncRun recovers prepared node commits after both event and state persistence fault windows", async () => {
  for (const fault of ["after-events", "after-state"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `sync-journal-${fault}`;
    const workflowRunId = `ultrafuzz-${runId}`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId,
        steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
      }),
      events: workflowEvents(workflowRunId, [
        { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
        { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
        { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 1 },
        { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 },
        { type: "RunFinished" }
      ])
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, `${fault}: ${JSON.stringify(run.diagnostics)}`);
    writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
    const layout = layoutForRunRoot(run.value!.run_root);
    const nodeIndex = path.join(layout.eventsIndexDir, "node", "project-discovery.jsonl");
    let injected = false;
    let preparedNodeSyncedId: string | undefined;
    let statusInFaultWindow: string | undefined;
    const inject = () => {
      if (injected) return;
      injected = true;
      const prepared = JSON.parse(fs.readFileSync(workflowSyncCommitJournalPath(layout), "utf8")) as {
        phase?: string;
        events?: Array<{ event_id?: string; event_type?: string }>;
      };
      assert.equal(prepared.phase, "prepared", fault);
      preparedNodeSyncedId = prepared.events?.find((event) => event.event_type === "node-synced")?.event_id;
      statusInFaultWindow = readRunState(layout).nodes["project-discovery"]?.status;
      fs.rmSync(nodeIndex);
      throw new Error(`injected ${fault} synchronization fault`);
    };
    await assert.rejects(
      syncRun(
        { projectRoot: project, runId, env },
        fault === "after-events" ? { afterEventsPersisted: inject } : { afterStatePersisted: inject }
      ),
      new RegExp(`injected ${fault} synchronization fault`, "u")
    );
    assert.equal(injected, true, fault);
    const nodeSyncedId = preparedNodeSyncedId;
    if (nodeSyncedId === undefined) throw new Error(`${fault}: prepared journal has no node-synced event`);
    assert.equal(statusInFaultWindow, fault === "after-state" ? "succeeded" : "pending", fault);

    const applied = JSON.parse(fs.readFileSync(workflowSyncCommitJournalPath(layout), "utf8")) as {
      phase?: string;
    };
    assert.equal(applied.phase, "applied", fault);
    assert.equal(readRunState(layout).nodes["project-discovery"]?.status, "succeeded", fault);
    const release = await acquireWorkflowMutationLock(layout);
    await release();
    for (const filePath of [layout.eventsPath, nodeIndex]) {
      const occurrences: number = fs
        .readFileSync(filePath, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line.includes(nodeSyncedId)).length;
      assert.equal(occurrences, 1, `${fault}: ${filePath}`);
    }

    const retried = await syncRun({ projectRoot: project, runId, env });
    assert.equal(retried.ok, true, `${fault}: ${JSON.stringify(retried.diagnostics)}`);
    assert.equal(
      replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter((event) => event.event_id === nodeSyncedId).length,
      1,
      fault
    );
  }
});

test("syncRun recovers prepared final-status commits after both event and state persistence fault windows", async () => {
  for (const fault of ["after-events", "after-state"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `sync-final-journal-${fault}`;
    const workflowRunId = `ultrafuzz-${runId}`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId,
        steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
      }),
      events: workflowEvents(workflowRunId, [
        { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
        { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
        { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 1 },
        { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 },
        { type: "RunFinished" }
      ])
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, `${fault}: ${JSON.stringify(run.diagnostics)}`);
    writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
    const layout = layoutForRunRoot(run.value!.run_root);
    const typeIndex = path.join(layout.eventsIndexDir, "type", "workflow-synced.jsonl");
    let injected = false;
    let preparedWorkflowSyncedId: string | undefined;
    let statusInFaultWindow: string | undefined;
    const inject = () => {
      if (injected) return;
      const prepared = JSON.parse(fs.readFileSync(workflowSyncCommitJournalPath(layout), "utf8")) as {
        phase?: string;
        events?: Array<{ event_id?: string; event_type?: string }>;
      };
      const workflowSynced = prepared.events?.find((event) => event.event_type === "workflow-synced");
      if (workflowSynced === undefined) return;
      injected = true;
      assert.equal(prepared.phase, "prepared", fault);
      preparedWorkflowSyncedId = workflowSynced.event_id;
      statusInFaultWindow = readRunState(layout).status;
      fs.rmSync(typeIndex);
      throw new Error(`injected final ${fault} synchronization fault`);
    };

    await assert.rejects(
      syncRun(
        { projectRoot: project, runId, env },
        fault === "after-events" ? { afterEventsPersisted: inject } : { afterStatePersisted: inject }
      ),
      new RegExp(`injected final ${fault} synchronization fault`, "u")
    );

    assert.equal(injected, true, fault);
    const workflowSyncedId = preparedWorkflowSyncedId;
    if (workflowSyncedId === undefined) throw new Error(`${fault}: prepared journal has no workflow-synced event`);
    assert.equal(statusInFaultWindow, fault === "after-state" ? "succeeded" : "running", fault);
    const applied = JSON.parse(fs.readFileSync(workflowSyncCommitJournalPath(layout), "utf8")) as {
      phase?: string;
    };
    assert.equal(applied.phase, "applied", fault);
    assert.equal(readRunState(layout).status, "succeeded", fault);
    for (const filePath of [layout.eventsPath, typeIndex]) {
      assert.equal(
        fs
          .readFileSync(filePath, "utf8")
          .split(/\r?\n/u)
          .filter((line) => line.includes(workflowSyncedId)).length,
        1,
        `${fault}: ${filePath}`
      );
    }
    const retried = await syncRun({ projectRoot: project, runId, env });
    assert.equal(retried.ok, true, `${fault}: ${JSON.stringify(retried.diagnostics)}`);
    assert.equal(
      replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter((event) => event.event_id === workflowSyncedId)
        .length,
      1,
      fault
    );
  }
});

test("syncRun rejects conflicting inspect, event, and state evidence before mutating durable state", async () => {
  const cases: Array<{
    name: string;
    inspect(workflowRunId: string): unknown;
    events(workflowRunId: string): string;
  }> = [
    {
      name: "conflicting inspect run ID",
      inspect: (workflowRunId) => ({
        ok: true,
        data: {
          run: { id: "different-workflow-run", status: "running" },
          runState: { runId: workflowRunId, state: "running" },
          steps: []
        }
      }),
      events: () => ""
    },
    {
      name: "conflicting event run ID",
      inspect: (workflowRunId) => workflowInspect({ workflowRunId, status: "running", state: "running", steps: [] }),
      events: () => `${JSON.stringify({ type: "RunStarted", runId: "different-workflow-run", seq: 1 })}\n`
    },
    {
      name: "contradictory inspect states",
      inspect: (workflowRunId) => ({
        ok: true,
        data: {
          run: { id: workflowRunId, status: "failed" },
          runState: { runId: workflowRunId, state: "running" },
          steps: []
        }
      }),
      events: () => ""
    }
  ];

  for (const testCase of cases) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `sync-invalid-identity-${crypto.randomUUID()}`;
    const workflowRunId = `ultrafuzz-${runId}`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: testCase.inspect(workflowRunId),
      events: testCase.events(workflowRunId),
      tokenEvents: ""
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, `${testCase.name}: ${JSON.stringify(run.diagnostics)}`);
    const statePath = path.join(run.value!.run_root, "state.json");
    const eventsPath = path.join(run.value!.run_root, "events.jsonl");
    const stateBefore = fs.readFileSync(statePath);
    const eventsBefore = fs.readFileSync(eventsPath);

    const synchronized = await syncRun({ projectRoot: project, runId, env });

    assert.equal(synchronized.ok, false, testCase.name);
    assert.equal(synchronized.diagnostics[0]?.code, "WORKFLOW_EVIDENCE_IDENTITY_INVALID", testCase.name);
    assert.equal(fs.readFileSync(statePath).equals(stateBefore), true, `${testCase.name}: state`);
    assert.equal(fs.readFileSync(eventsPath).equals(eventsBefore), true, `${testCase.name}: events`);
  }
});

test("bounded one-shot commands kill redirected TERM-resistant descendants after their parent exits", async () => {
  const project = tempProject();
  const binDir = path.join(project, "termination-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  const marker = path.join(project, "termination-child-pid");
  const descendantMarker = path.join(project, "termination-descendant-pid");
  fs.writeFileSync(
    smithers,
    `#!/bin/sh
printf '%s\n' "$$" > ${shellQuote(marker)}
( trap '' TERM; exec </dev/null >/dev/null 2>&1; while :; do sleep 1; done ) &
printf '%s\n' "$!" > ${shellQuote(descendantMarker)}
trap 'exit 0' TERM
while :; do sleep 1; done
`,
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  const env = createSmithersTestEnvironment(smithers);

  for (const mode of ["timeout", "abort"] as const) {
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    if (fs.existsSync(descendantMarker)) fs.unlinkSync(descendantMarker);
    const controller = new AbortController();
    const abortTimer = mode === "abort" ? setTimeout(() => controller.abort(), 100) : undefined;
    const startedAt = Date.now();
    const snapshot = await runSmithersInspectionCommand({
      args: ["inspect", `termination-${mode}`, "--format", "json"],
      projectRoot: project,
      env,
      ...(mode === "abort" ? { signal: controller.signal } : { timeoutMs: 100 })
    });
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    assert.equal(snapshot.ok, false, mode);
    assert.match(snapshot.error ?? "", mode === "abort" ? /was aborted/u : /timed out/u, mode);
    assert.ok(Date.now() - startedAt < 3_000, mode);
    for (const pidPath of [marker, descendantMarker]) {
      const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
      const processGoneDeadline = Date.now() + 2_000;
      while (Date.now() < processGoneDeadline) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          throw error;
        }
      }
      assert.throws(
        () => process.kill(pid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
        `${mode}: ${path.basename(pidPath)}`
      );
    }
  }
});

test("syncRun requires the deterministic verifier task to succeed", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-verifier-failed";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [
        { id: "node:project-discovery", state: "finished", attempt: 1 },
        { id: "verify:project-discovery", state: "failed", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "NodeFailed",
        nodeId: "verify:project-discovery",
        attempt: 1,
        error: { message: "deterministic artifact verification failed" }
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-verifier-failed", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-verifier-failed", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_VERIFIER_FAILED"));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      {
        status?: string;
        provenance?: {
          failure?: { category?: string; causal_task_id?: string; causal_failure_category?: string };
          workflow?: { task_id?: string };
        };
      }
    >;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.deepEqual(state.nodes?.["project-discovery"]?.provenance?.failure, {
    category: "artifact-contract",
    causal_task_id: "verify:project-discovery",
    causal_failure_category: "artifact-contract",
    dependent_task_ids: []
  });
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.task_id, "verify:project-discovery");
});

test("syncRun does not finalize an agent before its deterministic verifier has evidence", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-verifier-missing";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      includeVerifierSteps: false,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [{ type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 }])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-verifier-missing", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-verifier-missing", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_TASK_EVIDENCE_MISSING"));
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    false
  );
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.notEqual(state.nodes?.["project-discovery"]?.status, "succeeded");
});

test("syncRun finalizes prerequisite manifests before out-of-order descendants", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project);
  const workflowRunId = "ultrafuzz-sync-out-of-order";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [
        { id: "node:actors-flows", state: "finished", attempt: 1 },
        { id: "node:project-discovery", state: "finished", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:actors-flows", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-out-of-order", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md"]);
  writeRequiredArtifactSet(run.value!.run_root, "actors-flows", ["setup/actors-flows.md"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-out-of-order", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  const descendantManifest = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "artifacts", "actors-flows", "artifact-manifest.json"), "utf8")
  ) as { prerequisite_manifests?: Array<{ node_id?: string }> };
  assert.deepEqual(
    descendantManifest.prerequisite_manifests?.map((entry) => entry.node_id),
    ["project-discovery"]
  );
});

test("syncRun defers successful descendants until prerequisite artifact finalization completes", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project);
  const workflowRunId = "ultrafuzz-sync-prerequisite-grace";
  const env = fakeLifecycleSmithersEnv(project, {
    allowMissingVerifierArtifacts: true,
    inspect: workflowInspect({
      workflowRunId,
      steps: [
        { id: "node:actors-flows", state: "finished", attempt: 1 },
        { id: "node:project-discovery", state: "finished", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "node:actors-flows", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:actors-flows", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:actors-flows", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-prerequisite-grace", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "actors-flows", ["setup/actors-flows.md"]);
  const startedAt = Date.parse("2026-07-03T00:01:00.000Z");

  const pending = await syncRun(
    { projectRoot: project, runId: "sync-prerequisite-grace", env },
    { now: () => startedAt }
  );

  assert.equal(pending.ok, true, JSON.stringify(pending.diagnostics));
  assert.equal(pending.value?.status, "running");
  assert.ok(pending.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"));
  assert.ok(pending.diagnostics.some((diagnostic) => diagnostic.code === "PREREQUISITE_ARTIFACT_MANIFEST_PENDING"));
  const pendingState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(pendingState.nodes?.["project-discovery"]?.status, "running");
  assert.equal(pendingState.nodes?.["actors-flows"]?.status, "running");
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    false
  );
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "actors-flows", "artifact-manifest.json")),
    false
  );
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8"), "");

  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md"]);
  const completed = await syncRun(
    { projectRoot: project, runId: "sync-prerequisite-grace", env },
    { now: () => startedAt + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
  );

  assert.equal(completed.ok, true, JSON.stringify(completed.diagnostics));
  assert.equal(completed.value?.status, "succeeded");
  const completedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(completedState.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal(completedState.nodes?.["actors-flows"]?.status, "succeeded");
  const descendantManifest = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "artifacts", "actors-flows", "artifact-manifest.json"), "utf8")
  ) as { prerequisite_manifests?: Array<{ node_id?: string }> };
  assert.deepEqual(
    descendantManifest.prerequisite_manifests?.map((entry) => entry.node_id),
    ["project-discovery"]
  );
  const ledgerPath = path.join(run.value!.run_root, "attempts.jsonl");
  const ledgerText = fs.readFileSync(ledgerPath, "utf8");
  const ledger = ledgerText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { outcome?: string; failure_category?: string });
  assert.equal(ledger.length, 2);
  assert.deepEqual(
    ledger.map((entry) => entry.outcome),
    ["succeeded", "succeeded"]
  );
  assert.equal(
    ledger.some((entry) => entry.failure_category === "artifact-validation"),
    false
  );

  const replayed = await syncRun(
    { projectRoot: project, runId: "sync-prerequisite-grace", env },
    { now: () => startedAt + ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS }
  );
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.equal(replayed.value?.status, "succeeded");
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerText);
});

test("syncRun fails descendants closed after prerequisite artifact finalization fails", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project);
  const workflowRunId = "ultrafuzz-sync-prerequisite-failed";
  const env = fakeLifecycleSmithersEnv(project, {
    allowMissingVerifierArtifacts: true,
    inspect: workflowInspect({
      workflowRunId,
      steps: [
        { id: "node:actors-flows", state: "finished", attempt: 1 },
        { id: "node:project-discovery", state: "finished", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "node:actors-flows", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:actors-flows", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:actors-flows", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-prerequisite-failed", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "actors-flows", ["setup/actors-flows.md"]);
  const startedAt = Date.parse("2026-07-03T00:02:00.000Z");
  const pending = await syncRun(
    { projectRoot: project, runId: "sync-prerequisite-failed", env },
    { now: () => startedAt }
  );
  assert.equal(pending.value?.status, "running");

  const failed = await syncRun(
    { projectRoot: project, runId: "sync-prerequisite-failed", env },
    { now: () => startedAt + ARTIFACT_RECONCILIATION_GRACE_MS }
  );

  assert.equal(failed.ok, true, JSON.stringify(failed.diagnostics));
  assert.equal(failed.value?.status, "failed");
  assert.ok(failed.diagnostics.some((diagnostic) => diagnostic.code === "PREREQUISITE_ARTIFACT_MANIFEST_INVALID"));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      {
        status?: string;
        provenance?: {
          failure?: {
            category?: string;
            causal_task_id?: string;
            causal_failure_category?: string;
            dependent_task_ids?: string[];
          };
        };
      }
    >;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.equal(state.nodes?.["actors-flows"]?.status, "failed");
  assert.deepEqual(state.nodes?.["actors-flows"]?.provenance?.failure, {
    category: "dependency-cascade",
    causal_task_id: "verify:project-discovery",
    causal_failure_category: "artifact-contract",
    dependent_task_ids: ["node:actors-flows"]
  });
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "actors-flows", "artifact-manifest.json")),
    false
  );
  const ledger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { outcome?: string; failure_category?: string });
  assert.deepEqual(
    ledger.map((entry) => [entry.outcome, entry.failure_category]),
    [
      ["failed", "artifact-validation"],
      ["failed", "dependency"]
    ]
  );
});

test("syncRun fails a changed prerequisite receipt and invalidates its finalized descendant", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project);
  const workflowRunId = "ultrafuzz-sync-prerequisite-closure-changed";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [
        { id: "node:actors-flows", state: "finished", attempt: 1 },
        { id: "node:project-discovery", state: "finished", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "node:actors-flows", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:actors-flows", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:actors-flows", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-prerequisite-closure-changed", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md"]);
  writeRequiredArtifactSet(run.value!.run_root, "actors-flows", ["setup/actors-flows.md"]);
  const completed = await syncRun({ projectRoot: project, runId: "sync-prerequisite-closure-changed", env });
  assert.equal(completed.value?.status, "succeeded", JSON.stringify(completed.diagnostics));
  const prerequisiteManifestPath = path.join(
    run.value!.run_root,
    "artifacts",
    "project-discovery",
    "artifact-manifest.json"
  );
  const descendantManifestPath = path.join(run.value!.run_root, "artifacts", "actors-flows", "artifact-manifest.json");
  const ledgerPath = path.join(run.value!.run_root, "attempts.jsonl");
  const descendantManifest = fs.readFileSync(descendantManifestPath, "utf8");
  const ledger = fs.readFileSync(ledgerPath, "utf8");
  fs.appendFileSync(prerequisiteManifestPath, "\n", "utf8");

  const invalidated = await syncRun({
    projectRoot: project,
    runId: "sync-prerequisite-closure-changed",
    env
  });

  assert.equal(invalidated.ok, true, JSON.stringify(invalidated.diagnostics));
  assert.equal(invalidated.value?.status, "failed");
  assert.ok(invalidated.diagnostics.some((diagnostic) => diagnostic.code === "PREREQUISITE_ARTIFACT_CLOSURE_INVALID"));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.equal(state.nodes?.["actors-flows"]?.status, "invalidated");
  assert.equal(fs.readFileSync(descendantManifestPath, "utf8"), descendantManifest);
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledger);

  const replayed = await syncRun({
    projectRoot: project,
    runId: "sync-prerequisite-closure-changed",
    env
  });
  assert.equal(replayed.value?.status, "failed");
  const replayedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(replayedState.nodes?.["project-discovery"]?.status, "failed");
  assert.equal(replayedState.nodes?.["actors-flows"]?.status, "invalidated");
  assert.equal(fs.readFileSync(descendantManifestPath, "utf8"), descendantManifest);
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledger);
});

test("syncRun finalizes same-attempt success events ahead of stale prerequisite inspection", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project);
  const workflowRunId = "ultrafuzz-sync-stale-prerequisite";
  const afterInspection = Date.parse("2026-07-03T00:00:04.000Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [
        { id: "node:actors-flows", state: "finished", attempt: 1 },
        { id: "verify:actors-flows", state: "finished", attempt: 1 },
        { id: "node:project-discovery", state: "in-progress", attempt: 1 },
        { id: "verify:project-discovery", state: "in-progress", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, timestampMs: afterInspection },
      {
        type: "NodeFinished",
        nodeId: "verify:project-discovery",
        attempt: 1,
        timestampMs: afterInspection + 100
      },
      { type: "NodeFinished", nodeId: "node:actors-flows", attempt: 1, timestampMs: afterInspection + 200 },
      {
        type: "NodeFinished",
        nodeId: "verify:actors-flows",
        attempt: 1,
        timestampMs: afterInspection + 300
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-stale-prerequisite", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md"]);
  writeRequiredArtifactSet(run.value!.run_root, "actors-flows", ["setup/actors-flows.md"]);

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-stale-prerequisite", env },
    { now: () => Date.parse("2026-07-03T00:00:03.000Z") }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal(state.nodes?.["actors-flows"]?.status, "succeeded");
  const descendantManifest = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "artifacts", "actors-flows", "artifact-manifest.json"), "utf8")
  ) as { prerequisite_manifests?: Array<{ node_id?: string }> };
  assert.deepEqual(
    descendantManifest.prerequisite_manifests?.map((entry) => entry.node_id),
    ["project-discovery"]
  );
});

test("syncRun discards inspection and node evidence older than a continuation observed after inspection", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-continuation-after-inspection";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      computedAt: "2026-07-03T00:00:03.000Z",
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "RunAutoResumed", timestampMs: Date.parse("2026-07-03T00:00:02.000Z") }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-continuation-after-inspection", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-continuation-after-inspection", env },
    { now: () => Date.parse("2026-07-03T00:00:01.000Z") }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_INSPECT_PREDATES_CONTINUATION"));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "pending");
});

test("syncRun refreshes inspection when a continuation overlaps the first collection", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-refresh-after-continuation";
  const inspectMarker = path.join(project, "continuation-inspect-completed");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      computedAt: "2026-07-03T00:00:03.000Z",
      steps: [
        { id: "node:project-discovery", state: "in-progress", attempt: 1 },
        { id: "verify:project-discovery", state: "in-progress", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "RunAutoResumed", timestampMs: Date.parse("2026-07-03T00:00:02.000Z") }
    ]),
    inspectMarkerPath: inspectMarker
  });
  const run = await startRun({ projectRoot: project, runId: "sync-refresh-after-continuation", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const beforeContinuation = Date.parse("2026-07-03T00:00:01.000Z");
  const afterContinuation = Date.parse("2026-07-03T00:00:03.000Z");

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-refresh-after-continuation", env },
    { now: () => (fs.existsSync(inspectMarker) ? afterContinuation : beforeContinuation) }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  assert.equal(
    sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_INSPECT_PREDATES_CONTINUATION"),
    false
  );
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "running");
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.equal((commands.match(/^inspect /gmu) ?? []).length, 2);
  assert.equal((commands.match(/^events .* --type token /gmu) ?? []).length, 2);
});

test("syncRun defers terminal inspection when lifecycle-event collection cannot establish a fence", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-events-fence-failure";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 }
    ]),
    failEvents: true
  });
  const run = await startRun({ projectRoot: project, runId: "sync-events-fence-failure", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-events-fence-failure", env },
    { now: () => Date.parse("2026-07-03T00:00:03.000Z") }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_EVENTS_FAILED"));
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_EVENTS_REFRESH_FAILED"));
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_INSPECT_PREDATES_CONTINUATION"));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "pending");
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.equal((commands.match(/^inspect /gmu) ?? []).length, 2);
});

test("syncRun refreshes token accounting before accepting terminal refreshed state", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-refresh-terminal-accounting";
  const inspectMarker = path.join(project, "terminal-accounting-inspect-completed");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "RunAutoResumed", timestampMs: Date.parse("2026-07-03T00:00:02.000Z") },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: Date.parse("2026-07-03T00:00:02.050Z")
      },
      {
        type: "NodeFinished",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: Date.parse("2026-07-03T00:00:02.100Z")
      },
      {
        type: "NodeFinished",
        nodeId: "verify:project-discovery",
        attempt: 1,
        timestampMs: Date.parse("2026-07-03T00:00:02.200Z")
      }
    ]),
    tokenEvents: "",
    refreshedTokenEvents: workflowEvents(workflowRunId, [
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: Date.parse("2026-07-03T00:00:02.300Z"),
        extra: {
          iteration: 0,
          inputTokens: 10,
          outputTokens: 20,
          costUsd: 0.2,
          model: "deepseek-v4-flash",
          agent: "deepseek"
        }
      }
    ]),
    inspectMarkerPath: inspectMarker
  });
  const run = await startRun({ projectRoot: project, runId: "sync-refresh-terminal-accounting", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const beforeContinuation = Date.parse("2026-07-03T00:00:01.000Z");
  const afterContinuation = Date.parse("2026-07-03T00:00:03.000Z");

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-refresh-terminal-accounting", env },
    { now: () => (fs.existsSync(inspectMarker) ? afterContinuation : beforeContinuation) }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: { current?: { total_tokens?: number; event_count?: number } };
  };
  assert.equal(metadata.accounting?.current?.total_tokens, 30);
  assert.equal(metadata.accounting?.current?.event_count, 1);
});

test("syncRun uses lifecycle submission commit time as the fallback continuation boundary", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-lifecycle-commit-boundary";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      computedAt: "2026-07-03T00:00:03.000Z",
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-lifecycle-commit-boundary", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  appendEvent(layoutForRunRoot(run.value!.run_root), {
    eventType: "workflow-lifecycle-submitted",
    status: "running",
    timestamp: "2026-07-03T00:00:02.000Z",
    payload: {
      action: "resume",
      workflow_run_id: workflowRunId,
      controller_invocation_id: "controller-lifecycle-commit",
      controller_invoked_at: "2026-07-03T00:00:00.500Z"
    }
  });

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-lifecycle-commit-boundary", env },
    { now: () => Date.parse("2026-07-03T00:00:01.000Z") }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "pending");
});

test("syncRun defers stale mutations when a lifecycle continuation commits after evidence collection", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-lifecycle-commit-race";
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: { inputTokens: 10, outputTokens: 5, costUsd: 0.1, model: "gpt-test", agent: "openai" }
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const manifestPath = path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json");
  let lifecycleSnapshot:
    { state: string; metadata: string; attempts: string; usage: string; events: string } | undefined;

  const sync = await syncRun(
    { projectRoot: project, runId, env },
    {
      beforeCommit: async () => {
        const resumed = await resumeRun({ projectRoot: project, runId, force: true, env });
        assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
        assert.equal(resumed.value?.submitted, true);
        lifecycleSnapshot = {
          state: fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8"),
          metadata: fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8"),
          attempts: fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8"),
          usage: fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8"),
          events: fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8")
        };
      }
    }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  assert.equal(sync.value?.synced_nodes, 0);
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CONTINUATION_CHANGED"));
  assert.ok(lifecycleSnapshot);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8"), lifecycleSnapshot.state);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8"), lifecycleSnapshot.metadata);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8"), lifecycleSnapshot.attempts);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8"), lifecycleSnapshot.usage);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8"), lifecycleSnapshot.events);
  assert.equal(fs.existsSync(manifestPath), false);
  const state = JSON.parse(lifecycleSnapshot.state) as { nodes?: Record<string, { status?: string }> };
  assert.equal(state.nodes?.["project-discovery"]?.status, "pending");
});

test("syncRun rejects a sealed control replacement at the commit boundary without durable mutation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-control-commit-race";
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [])
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const statePath = path.join(run.value!.run_root, "state.json");
  const attemptsPath = path.join(run.value!.run_root, "attempts.jsonl");
  const usagePath = path.join(run.value!.run_root, "usage.jsonl");
  const eventsPath = path.join(run.value!.run_root, "events.jsonl");
  const before = {
    state: fs.readFileSync(statePath, "utf8"),
    attempts: fs.readFileSync(attemptsPath, "utf8"),
    usage: fs.readFileSync(usagePath, "utf8"),
    events: fs.readFileSync(eventsPath, "utf8")
  };

  const synchronized = await syncRun(
    { projectRoot: project, runId, env },
    {
      beforeCommit: () => {
        fs.appendFileSync(path.join(run.value!.run_root, "smithers", "tasks.json"), "hostile replacement\n", "utf8");
      }
    }
  );

  assert.equal(synchronized.ok, true, JSON.stringify(synchronized.diagnostics));
  assert.equal(synchronized.value?.synced_nodes, 0);
  assert.ok(synchronized.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CONTROL_CHANGED"));
  assert.equal(fs.readFileSync(statePath, "utf8"), before.state);
  assert.equal(fs.readFileSync(attemptsPath, "utf8"), before.attempts);
  assert.equal(fs.readFileSync(usagePath, "utf8"), before.usage);
  assert.equal(fs.readFileSync(eventsPath, "utf8"), before.events);
});

test("syncRun defers stale mutations while a lifecycle invocation remains in flight", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-lifecycle-invoking-race";
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: { inputTokens: 10, outputTokens: 5, costUsd: 0.1, model: "gpt-test", agent: "openai" }
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const layout = layoutForRunRoot(run.value!.run_root);
  const sourceLink = verifyCommittedWorkflowRunLink(layout);
  const controlSnapshot = verifyWorkflowControlSnapshot(project, layout);
  const invocationSnapshot = materializeWorkflowExecutionSnapshot({
    projectRoot: project,
    layout,
    snapshot: controlSnapshot
  });
  appendEvent(layout, {
    eventType: "workflow-lifecycle-invoking",
    status: "running",
    payload: {
      action: "resume",
      workflow_run_id: workflowRunId,
      control_generation: controlSnapshot.generation,
      workflow_link_id: sourceLink.link_id,
      execution_snapshot_root: invocationSnapshot.root
    }
  });
  const durableSnapshot = {
    state: fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8"),
    metadata: fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8"),
    attempts: fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8"),
    usage: fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8"),
    events: fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8")
  };
  const manifestPath = path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json");

  const sync = await syncRun({ projectRoot: project, runId, env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  assert.equal(sync.value?.synced_nodes, 0);
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CONTINUATION_CHANGED"));
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8"), durableSnapshot.state);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8"), durableSnapshot.metadata);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8"), durableSnapshot.attempts);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8"), durableSnapshot.usage);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8"), durableSnapshot.events);
  assert.equal(fs.existsSync(manifestPath), false);

  const resumed = await resumeRun({ projectRoot: project, runId, force: true, env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  const continuedAt = Date.now() + 1_000;
  fs.writeFileSync(
    env.SMITHERS_FAKE_EVENTS!,
    workflowEvents(workflowRunId, [
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: continuedAt
      },
      {
        type: "NodeFinished",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: continuedAt + 1
      },
      {
        type: "NodeStarted",
        nodeId: "verify:project-discovery",
        attempt: 1,
        timestampMs: continuedAt + 2
      },
      {
        type: "NodeFinished",
        nodeId: "verify:project-discovery",
        attempt: 1,
        timestampMs: continuedAt + 3
      }
    ]),
    "utf8"
  );
  const lifecycleEvents = fs
    .readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event_id?: string; event_type?: string; payload?: Record<string, unknown> })
    .filter((event) => event.event_type?.startsWith("workflow-lifecycle-"));
  const orphanedInvocation = lifecycleEvents.find((event) => event.event_type === "workflow-lifecycle-invoking");
  const orphanedFailure = lifecycleEvents.find(
    (event) =>
      event.event_type === "workflow-lifecycle-failed" &&
      event.payload?.failure_reason === "orphaned-lifecycle-invocation-superseded"
  );
  assert.ok(orphanedInvocation);
  assert.ok(orphanedFailure);
  assert.equal(orphanedFailure.payload?.controller_invocation_id, orphanedInvocation.event_id);

  const recovered = await syncRun({ projectRoot: project, runId, env });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
  assert.equal(recovered.value?.status, "succeeded");
  assert.equal(recovered.value?.synced_nodes, 1);
  assert.equal(
    recovered.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CONTINUATION_CHANGED"),
    false
  );
  assert.equal(fs.existsSync(manifestPath), true);
});

test("syncRun treats a repeated RunStarted event as a durable continuation boundary", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-repeated-run-started";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [
        { id: "node:project-discovery", state: "in-progress", attempt: 1 },
        { id: "verify:project-discovery", state: "in-progress", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "RunStarted" },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "RunStarted", timestampMs: Date.parse("2026-07-03T00:00:02.000Z") }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-repeated-run-started", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-repeated-run-started", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "running");
});

test("syncRun rejects same-millisecond node evidence sequenced before a continuation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-equal-time-stale-events";
  const boundaryTime = Date.parse("2026-07-03T00:00:02.000Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [
        { id: "node:project-discovery", state: "in-progress", attempt: 1 },
        { id: "verify:project-discovery", state: "in-progress", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, timestampMs: boundaryTime },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1, timestampMs: boundaryTime },
      { type: "RunAutoResumed", timestampMs: boundaryTime }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-equal-time-stale-events", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-equal-time-stale-events", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "running");
});

test("syncRun aggregates only same-millisecond node events sequenced after a continuation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-equal-time-current-events";
  const boundaryTime = Date.parse("2026-07-03T00:00:02.000Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, timestampMs: boundaryTime },
      { type: "TaskHeartbeatTimeout", nodeId: "node:project-discovery", attempt: 1, timestampMs: boundaryTime },
      { type: "RunAutoResumed", timestampMs: boundaryTime },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: boundaryTime,
        error: { message: "current ordinary failure" }
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-equal-time-current-events", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-equal-time-current-events", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; started_at?: string; last_error?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.equal(state.nodes?.["project-discovery"]?.started_at, undefined);
  assert.equal(state.nodes?.["project-discovery"]?.last_error, "current ordinary failure");
});

test("syncRun accepts post-continuation sequence evidence despite a rolled-back timestamp", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-new-sequence-rolled-back-time";
  const boundaryTime = Date.parse("2026-07-03T00:00:02.000Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "RunAutoResumed", sequence: 100, timestampMs: boundaryTime },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 101,
        timestampMs: boundaryTime - 1_000,
        error: { message: "failure after clock rollback" }
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-new-sequence-rolled-back-time", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-new-sequence-rolled-back-time", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; last_error?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.equal(state.nodes?.["project-discovery"]?.last_error, "failure after clock rollback");
});

test("syncRun rejects pre-continuation sequence evidence despite a newer timestamp", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-old-sequence-newer-time";
  const boundaryTime = Date.parse("2026-07-03T00:00:02.000Z");
  const inspectionTime = boundaryTime + 1_000;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 99,
        timestampMs: inspectionTime + 1_000,
        error: { message: "stale failure with a future timestamp" }
      },
      { type: "RunAutoResumed", sequence: 100, timestampMs: boundaryTime }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-old-sequence-newer-time", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-old-sequence-newer-time", env },
    { now: () => inspectionTime }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; last_error?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "running");
  assert.equal(state.nodes?.["project-discovery"]?.last_error, undefined);
});

test("syncRun selects the newest continuation by sequence when continuation timestamps roll back", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-multiple-continuation-rollback";
  const firstContinuationTime = Date.parse("2026-07-03T00:00:02.000Z");
  const rolledBackContinuationTime = Date.parse("2026-07-03T00:00:01.000Z");
  const inspectionTime = Date.parse("2026-07-03T00:00:03.000Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "RunAutoResumed", sequence: 100, timestampMs: firstContinuationTime },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 150,
        timestampMs: inspectionTime + 1_000,
        error: { message: "failure from the superseded continuation" }
      },
      { type: "RunHijacked", sequence: 200, timestampMs: rolledBackContinuationTime }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-multiple-continuation-rollback", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-multiple-continuation-rollback", env },
    { now: () => inspectionTime }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; last_error?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "running");
  assert.equal(state.nodes?.["project-discovery"]?.last_error, undefined);
});

test("syncRun rejects a stale same-number success event for a running continuation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-stale-same-number-success";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunAutoResumed", timestampMs: Date.parse("2026-07-03T00:00:02.000Z") }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-stale-same-number-success", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-stale-same-number-success", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; provenance?: { workflow?: { attempt?: number } } }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "running");
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.attempt, 1);
});

test("syncRun rejects stale same-number failure details for a matching inspected failure", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-stale-same-number-failure-details";
  const continuedStartedAt = Date.parse("2026-07-03T00:00:02.100Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        error: { message: "failure from the prior continuation" }
      },
      { type: "RunAutoResumed", timestampMs: Date.parse("2026-07-03T00:00:02.000Z") },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: continuedStartedAt
      },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: continuedStartedAt + 100
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-stale-same-number-failure-details", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-stale-same-number-failure-details", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      { status?: string; started_at?: string; last_error?: string; provenance?: { workflow?: { attempt?: number } } }
    >;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.equal(state.nodes?.["project-discovery"]?.started_at, new Date(continuedStartedAt).toISOString());
  assert.equal(state.nodes?.["project-discovery"]?.last_error, undefined);
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.attempt, 1);
});

test("syncRun rejects stale same-number timing for a matching inspected success", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-stale-same-number-success-timing";
  const staleFinishedAt = "2026-07-03T00:00:00.100Z";
  const continuedStartedAt = Date.parse("2026-07-03T00:00:02.100Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunAutoResumed", timestampMs: Date.parse("2026-07-03T00:00:02.000Z") },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: continuedStartedAt
      },
      {
        type: "NodeFinished",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: continuedStartedAt + 100
      },
      {
        type: "NodeStarted",
        nodeId: "verify:project-discovery",
        attempt: 1,
        timestampMs: continuedStartedAt + 200
      },
      {
        type: "NodeFinished",
        nodeId: "verify:project-discovery",
        attempt: 1,
        timestampMs: continuedStartedAt + 300
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-stale-same-number-success-timing", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-stale-same-number-success-timing", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; started_at?: string; finished_at?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery"]?.started_at, new Date(continuedStartedAt + 200).toISOString());
  assert.notEqual(state.nodes?.["project-discovery"]?.finished_at, staleFinishedAt);
});

test("syncRun preserves matching event timing from the initial workflow generation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-initial-generation-success-timing";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-initial-generation-success-timing", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-initial-generation-success-timing", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; started_at?: string; finished_at?: string }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery"]?.started_at, "2026-07-03T00:00:00.200Z");
  assert.equal(state.nodes?.["project-discovery"]?.finished_at, "2026-07-03T00:00:00.300Z");
});

test("syncRun keeps newer inspected nonterminal state over an older same-attempt event", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-newer-inspected-nonterminal";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [{ type: "NodePending", nodeId: "node:project-discovery", attempt: 1 }])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-newer-inspected-nonterminal", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-newer-inspected-nonterminal", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; provenance?: { workflow?: { state?: string } } }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "running");
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.state, "in-progress");
});

test("syncRun prefers a newer successful inspection attempt over an older failed event", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-newer-inspection-attempt";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 2 }]
    }),
    events: workflowEvents(workflowRunId, [
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        error: { message: "older attempt failed" }
      },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 2 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 2 },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 2 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 2 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-newer-inspection-attempt", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-newer-inspection-attempt", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; last_error?: string; provenance?: { workflow?: { attempt?: number } } }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery"]?.last_error, undefined);
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.attempt, 2);
});

test("syncRun prefers a newer failed inspection attempt over an older successful event", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-newer-failed-inspection-attempt";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 2 }]
    }),
    events: workflowEvents(workflowRunId, [{ type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 }])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-newer-failed-inspection-attempt", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-newer-failed-inspection-attempt", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; provenance?: { workflow?: { attempt?: number } } }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.attempt, 2);
});

test("syncRun prefers inspection over a stale terminal event with the same restarted attempt", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-stale-restarted-event-attempt";
  const continuedStartedAt = Date.parse("2026-07-03T00:00:02.100Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        error: { message: "stale restarted attempt failed" }
      },
      { type: "RunAutoResumed", timestampMs: Date.parse("2026-07-03T00:00:02.000Z") },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: continuedStartedAt
      },
      {
        type: "NodeFinished",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: continuedStartedAt + 100
      },
      {
        type: "NodeStarted",
        nodeId: "verify:project-discovery",
        attempt: 1,
        timestampMs: continuedStartedAt + 200
      },
      {
        type: "NodeFinished",
        nodeId: "verify:project-discovery",
        attempt: 1,
        timestampMs: continuedStartedAt + 300
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-stale-restarted-event-attempt", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-stale-restarted-event-attempt", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; last_error?: string; provenance?: { workflow?: { attempt?: number } } }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery"]?.last_error, undefined);
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.attempt, 1);
});

test("syncRun accepts a newer event attempt after a continuation counter restart", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-newer-restarted-event-attempt";
  const afterInspection = Date.parse("2026-07-03T00:00:04.000Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [
        { id: "node:project-discovery", state: "failed", attempt: 2 },
        { id: "verify:project-discovery", state: "failed", attempt: 2 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, timestampMs: afterInspection },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, timestampMs: afterInspection + 100 },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 1, timestampMs: afterInspection + 200 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 1, timestampMs: afterInspection + 300 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-newer-restarted-event-attempt", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-newer-restarted-event-attempt", env },
    { now: () => Date.parse("2026-07-03T00:00:03.000Z") }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; provenance?: { workflow?: { attempt?: number } } }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.attempt, 1);
});

test("syncRun accepts a terminal event that finishes after the inspection snapshot", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-event-finishes-after-inspection";
  const beforeInspection = Date.parse("2026-07-03T00:00:02.900Z");
  const afterInspection = Date.parse("2026-07-03T00:00:03.100Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, timestampMs: beforeInspection },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, timestampMs: afterInspection },
      {
        type: "NodeStarted",
        nodeId: "verify:project-discovery",
        attempt: 1,
        timestampMs: afterInspection + 100
      },
      {
        type: "NodeFinished",
        nodeId: "verify:project-discovery",
        attempt: 1,
        timestampMs: afterInspection + 200
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-event-finishes-after-inspection", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-event-finishes-after-inspection", env },
    { now: () => Date.parse("2026-07-03T00:00:03.000Z") }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; provenance?: { workflow?: { attempt?: number } } }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.attempt, 1);
});

test("syncRun accepts a newer same-number retry event over a terminal inspection row", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-newer-same-number-retry";
  const afterInspection = Date.parse("2026-07-03T00:00:04.000Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeRetrying", nodeId: "node:project-discovery", attempt: 1, timestampMs: afterInspection }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-newer-same-number-retry", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-newer-same-number-retry", env },
    { now: () => Date.parse("2026-07-03T00:00:03.000Z") }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; provenance?: { workflow?: { state?: string; attempt?: number } } }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "running");
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.state, "retrying");
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.attempt, 1);
});

test("syncRun does not relabel a stale unnumbered terminal event as the inspected attempt", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-stale-unnumbered-event";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 2 }]
    }),
    events: workflowEvents(workflowRunId, [
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        error: { message: "stale unnumbered failure" }
      },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 2 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 2 },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 2 },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 2 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-stale-unnumbered-event", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-stale-unnumbered-event", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; last_error?: string; provenance?: { workflow?: { attempt?: number } } }>;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery"]?.last_error, undefined);
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.workflow?.attempt, 2);
});

test("syncRun does not mark a completed workflow succeeded without task evidence", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-missing-evidence";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: {
      ok: true,
      data: {
        run: { id: workflowRunId, status: "completed" },
        runState: { runId: workflowRunId, state: "completed" },
        steps: []
      }
    },
    events: ""
  });
  const run = await startRun({ projectRoot: project, runId: "sync-missing-evidence", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-missing-evidence", env });

  assert.equal(sync.ok, true);
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_TASK_EVIDENCE_MISSING"));
});

test("syncRun accepts workflow nodes and top-level event fields", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-alt-shapes";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: {
      ok: true,
      data: {
        run: { id: workflowRunId, status: "completed" },
        runState: { runId: workflowRunId, state: "completed" },
        nodes: [
          { nodeId: "node:project-discovery", status: "completed", attemptIndex: 0 },
          { nodeId: "verify:project-discovery", status: "completed", attemptIndex: 0 }
        ]
      }
    },
    events: `${[
      { nodeId: "node:project-discovery", timestampMs: Date.parse("2026-07-03T00:00:00.000Z") },
      { nodeId: "verify:project-discovery", timestampMs: Date.parse("2026-07-03T00:00:00.100Z") }
    ]
      .map((event) =>
        JSON.stringify({
          runId: workflowRunId,
          timestampMs: event.timestampMs,
          event: "NodeFinished",
          nodeId: event.nodeId,
          attempt: 0
        })
      )
      .join("\n")}\n`
  });
  const run = await startRun({ projectRoot: project, runId: "sync-alt-shapes", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-alt-shapes", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
});

test("syncRun maps failed workflow nodes into durable failed run state", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-failed-node";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 2 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "TaskHeartbeatTimeout", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFailed", nodeId: "node:project-discovery", attempt: 1, error: { message: "agent failed" } },
      { type: "NodeRetrying", nodeId: "node:project-discovery", attempt: 2 },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 2 },
      { type: "NodeFailed", nodeId: "node:project-discovery", attempt: 2, error: { message: "agent failed again" } }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-failed-node", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-failed-node", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      {
        status?: string;
        retry_count?: number;
        last_error?: string;
        provenance?: {
          failure?: { category?: string; causal_task_id?: string; causal_failure_category?: string };
        };
      }
    >;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  assert.equal(state.nodes?.["project-discovery"]?.retry_count, 1);
  assert.equal(state.nodes?.["project-discovery"]?.last_error, "agent failed again");
  assert.deepEqual(state.nodes?.["project-discovery"]?.provenance?.failure, {
    category: "agent-failure",
    causal_task_id: "node:project-discovery",
    causal_failure_category: "agent-failure",
    dependent_task_ids: []
  });
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    false
  );
  const failedLedger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    failedLedger.map((entry) => entry.outcome),
    ["timed-out", "failed"]
  );

  const resumedEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "running", attempt: 3 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeRetrying", nodeId: "node:project-discovery", attempt: 3 },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 3 }
    ])
  });
  const resumed = await syncRun({ projectRoot: project, runId: "sync-failed-node", env: resumedEnv });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.status, "running");
  const resumedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    status?: string;
    finished_at?: string;
    nodes?: Record<string, { status?: string; last_error?: string; finished_at?: string }>;
  };
  assert.equal(resumedState.status, "running");
  assert.equal(resumedState.finished_at, undefined);
  assert.equal(resumedState.nodes?.["project-discovery"]?.status, "running");
  assert.equal(resumedState.nodes?.["project-discovery"]?.last_error, undefined);
  assert.equal(resumedState.nodes?.["project-discovery"]?.finished_at, undefined);
});

test("syncRun classifies allowlisted agent postflight failures as artifact contract failures", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-agent-postflight-failed";
  const privateDetail = "private artifact detail Authorization: Bearer sk-private-state-secret";
  const failureMessage = `ultrafuzz-agent-postflight:artifact-validation-postflight: ${privateDetail}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        error: { message: failureMessage }
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-agent-postflight-failed", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-agent-postflight-failed", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const diagnostic = sync.diagnostics.find((entry) => entry.code === "AGENT_POSTFLIGHT_FAILED");
  assert.deepEqual(diagnostic, {
    code: "AGENT_POSTFLIGHT_FAILED",
    message: "agent postflight failed at artifact-validation-postflight for project-discovery",
    severity: "error",
    source: "artifact-contracts",
    path: "node:project-discovery"
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private artifact detail|sk-private-state-secret/u);
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      {
        provenance?: {
          failure?: {
            category?: string;
            code?: string;
            causal_task_id?: string;
            causal_failure_category?: string;
          };
        };
      }
    >;
  };
  assert.deepEqual(state.nodes?.["project-discovery"]?.provenance?.failure, {
    category: "artifact-contract",
    code: "artifact-validation-postflight",
    causal_task_id: "node:project-discovery",
    causal_failure_category: "artifact-contract",
    dependent_task_ids: []
  });
  const attempts = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { failure_category?: string });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.failure_category, "artifact-validation");

  const attemptsPath = path.join(run.value!.run_root, "attempts.jsonl");
  fs.writeFileSync(attemptsPath, "", "utf8");
  const replayed = await syncRun({ projectRoot: project, runId: "sync-agent-postflight-failed", env });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  const replayedAttempts = fs
    .readFileSync(attemptsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { failure_category?: string });
  assert.equal(replayedAttempts.length, 1);
  assert.equal(replayedAttempts[0]?.failure_category, "artifact-validation");
});

test("syncRun selects the current terminal retry by sequence when attempt timestamps roll back", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-sequence-rollback";
  const laterWallClock = Date.parse("2026-07-03T00:00:04.000Z");
  const rolledBackWallClock = Date.parse("2026-07-03T00:00:01.000Z");
  const postflightFailure = "ultrafuzz-agent-postflight:artifact-validation-postflight: rolled-back attempt";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 100,
        timestampMs: laterWallClock,
        extra: { iteration: 0, executorRetryId: "retry-before-rollback" }
      },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 101,
        timestampMs: laterWallClock + 100,
        error: { message: "ordinary provider failure" },
        extra: { iteration: 0 }
      },
      {
        type: "RunAutoResumed",
        sequence: 190,
        timestampMs: laterWallClock + 200,
        extra: { controllerInvocationId: "controller-after-rollback" }
      },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 200,
        timestampMs: rolledBackWallClock,
        extra: { iteration: 1, executorRetryId: "retry-after-rollback" }
      },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 201,
        timestampMs: rolledBackWallClock + 100,
        error: { message: postflightFailure },
        extra: { iteration: 1 }
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-sequence-rollback", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "attempt-sequence-rollback", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const attempts = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          executor_retry_id?: string;
          failure_category?: string;
          controller_invocation_id?: string;
        }
    );
  assert.equal(
    attempts.find((attempt) => attempt.executor_retry_id === "retry-before-rollback")?.failure_category,
    "executor-error"
  );
  assert.equal(
    attempts.find((attempt) => attempt.executor_retry_id === "retry-after-rollback")?.failure_category,
    "artifact-validation"
  );
  assert.equal(
    attempts.find((attempt) => attempt.executor_retry_id === "retry-after-rollback")?.controller_invocation_id,
    "controller-after-rollback"
  );
});

test("syncRun preserves retry and checkpoint generations in the immutable attempt ledger", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-ledger";
  const firstExecutionEvents = [
    {
      type: "NodeStarted",
      nodeId: "node:project-discovery",
      attempt: 1,
      extra: {
        iteration: 0,
        checkpointGenerationId: "checkpoint-1",
        workflowExecutionId: "execution-1",
        controllerInvocationId: "controller-1"
      }
    },
    {
      type: "NodeFailed",
      nodeId: "node:project-discovery",
      attempt: 1,
      error: { message: "generated executor failure" },
      extra: { iteration: 0 }
    },
    { type: "NodeRetrying", nodeId: "node:project-discovery", attempt: 2, extra: { iteration: 0 } },
    {
      type: "NodeStarted",
      nodeId: "node:project-discovery",
      attempt: 2,
      extra: {
        iteration: 0,
        checkpointGenerationId: "checkpoint-1",
        workflowExecutionId: "execution-1",
        controllerInvocationId: "controller-1"
      }
    },
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 2, extra: { iteration: 0 } }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 2 }]
    }),
    events: workflowEvents(workflowRunId, firstExecutionEvents)
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-ledger", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const firstSync = await syncRun({ projectRoot: project, runId: "attempt-ledger", env });
  assert.equal(firstSync.ok, true, JSON.stringify(firstSync.diagnostics));

  const continuedEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 3 }]
    }),
    events: workflowEvents(workflowRunId, [
      ...firstExecutionEvents,
      { type: "NodeRetrying", nodeId: "node:project-discovery", attempt: 3, extra: { iteration: 1 } },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 3,
        extra: {
          iteration: 1,
          checkpointGenerationId: "checkpoint-2",
          workflowExecutionId: "execution-2",
          controllerInvocationId: "controller-2"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 3, extra: { iteration: 1 } }
    ])
  });
  const continued = await syncRun({ projectRoot: project, runId: "attempt-ledger", env: continuedEnv });
  const replayed = await syncRun({ projectRoot: project, runId: "attempt-ledger", env: continuedEnv });
  assert.equal(continued.ok, true, JSON.stringify(continued.diagnostics));
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));

  const ledgerText = fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8");
  const ledger = ledgerText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(ledger.length, 3);
  assert.doesNotMatch(ledgerText, /generated executor failure/u);
  assert.equal(ledger[0]?.failure_category, "executor-error");
  assert.equal(ledger[1]?.parent_attempt_id, ledger[0]?.attempt_id);
  assert.equal(ledger[2]?.parent_attempt_id, ledger[1]?.attempt_id);

  const status = await getRunStatus({ projectRoot: project, runId: "attempt-ledger", env: continuedEnv });
  assert.deepEqual(status.value?.attempts, {
    total: 3,
    executed: 3,
    reused: 0,
    outcomes: { succeeded: 2, failed: 1, "timed-out": 0, canceled: 0, skipped: 0, reused: 0 },
    strategy_attempts: 1,
    executor_retries: 3,
    checkpoint_generations: 2,
    workflow_executions: 2,
    controller_invocations: 2
  });
  assert.equal(status.value?.state?.nodes["project-discovery"]?.retry_count, 2);
});

test("syncRun records checkpoint continuation entries even when workflow retry counters restart", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-ledger-restarted-counter";
  const firstExecutionEvents = [
    {
      type: "NodeStarted",
      nodeId: "node:project-discovery",
      attempt: 1,
      extra: {
        iteration: 0,
        checkpointGenerationId: "checkpoint-1",
        workflowExecutionId: "execution-1",
        controllerInvocationId: "controller-1"
      }
    },
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, firstExecutionEvents)
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-ledger-restarted-counter", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const firstSync = await syncRun({ projectRoot: project, runId: "attempt-ledger-restarted-counter", env });
  assert.equal(firstSync.ok, true, JSON.stringify(firstSync.diagnostics));

  const continuedEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      ...firstExecutionEvents,
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "checkpoint-2",
          workflowExecutionId: "execution-2",
          controllerInvocationId: "controller-2"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } }
    ])
  });
  const continued = await syncRun({
    projectRoot: project,
    runId: "attempt-ledger-restarted-counter",
    env: continuedEnv
  });
  const replayed = await syncRun({
    projectRoot: project,
    runId: "attempt-ledger-restarted-counter",
    env: continuedEnv
  });
  assert.equal(continued.ok, true, JSON.stringify(continued.diagnostics));
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));

  const ledgerText = fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8");
  const ledger = ledgerText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[1]?.parent_attempt_id, ledger[0]?.attempt_id);

  const status = await getRunStatus({
    projectRoot: project,
    runId: "attempt-ledger-restarted-counter",
    env: continuedEnv
  });
  assert.deepEqual(status.value?.attempts, {
    total: 2,
    executed: 2,
    reused: 0,
    outcomes: { succeeded: 2, failed: 0, "timed-out": 0, canceled: 0, skipped: 0, reused: 0 },
    strategy_attempts: 1,
    executor_retries: 2,
    checkpoint_generations: 2,
    workflow_executions: 2,
    controller_invocations: 2
  });
});

test("syncRun distinguishes repeated retry counters by their workflow event identity", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-ledger-repeated-dimensions";
  const repeatedDimensions = {
    iteration: 0,
    checkpointGenerationId: "checkpoint-1",
    workflowExecutionId: "execution-1",
    controllerInvocationId: "controller-1"
  };
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: repeatedDimensions
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: repeatedDimensions
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-ledger-repeated-dimensions", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "attempt-ledger-repeated-dimensions", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.ok(!sync.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  const ledger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(ledger.length, 2);
  assert.equal(new Set(ledger.map((entry) => entry.attempt_id)).size, 2);
  assert.equal(new Set(ledger.map((entry) => entry.executor_retry_id)).size, 2);
});

test("syncRun keeps a terminal-only retry idempotent when its start event arrives later", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-ledger-late-start";
  const startedAt = Date.parse("2026-07-03T00:00:00.100Z");
  const finishedAt = Date.parse("2026-07-03T00:00:00.200Z");
  const terminalEvent = {
    type: "NodeFailed",
    nodeId: "node:project-discovery",
    attempt: 1,
    sequence: 2,
    timestampMs: finishedAt,
    error: { message: "generated executor failure" }
  };
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [terminalEvent])
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-ledger-late-start", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const firstSync = await syncRun({ projectRoot: project, runId: "attempt-ledger-late-start", env });
  assert.equal(firstSync.ok, true, JSON.stringify(firstSync.diagnostics));
  const initialLedger = fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8");

  const completeEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 1,
        timestampMs: startedAt
      },
      terminalEvent
    ])
  });
  const replayed = await syncRun({
    projectRoot: project,
    runId: "attempt-ledger-late-start",
    env: completeEnv
  });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.ok(!replayed.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8"), initialLedger);
  assert.equal(initialLedger.trim().split("\n").length, 1);
});

test("syncRun attributes attempts to the controller active when the attempt starts", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-ledger-controller";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 2 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "RunStarted", extra: { controllerInvocationId: "controller-start" } },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "checkpoint-1",
          workflowExecutionId: "execution-1"
        }
      },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        error: { message: "first controller attempt failed" },
        extra: { iteration: 0 }
      },
      { type: "RunAutoResumed", extra: { controllerInvocationId: "controller-resume" } },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 2,
        extra: {
          iteration: 1,
          checkpointGenerationId: "checkpoint-2",
          workflowExecutionId: "execution-2"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 2, extra: { iteration: 1 } },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 2, extra: { iteration: 1 } },
      { type: "NodeFinished", nodeId: "verify:project-discovery", attempt: 2, extra: { iteration: 1 } }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-ledger-controller", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "attempt-ledger-controller", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));

  const ledgerText = fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8");
  const ledger = ledgerText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0]?.controller_invocation_id, "controller-start");
  assert.equal(ledger[1]?.controller_invocation_id, "controller-resume");
});

test("syncRun keeps skipped override attempts schema-valid", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-attempt-ledger-skipped-override";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "skipped", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "attempt-ledger-skipped-override", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "attempt-ledger-skipped-override", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.ok(!sync.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));

  const ledger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.outcome, "skipped");
  assert.equal(ledger[0]?.failure_category, undefined);
  assert.deepEqual(ledger[0]?.reuse, { status: "executed" });
});

test("syncRun records reused override attempts with an idempotent source reference", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const sourceWorkflowRunId = "ultrafuzz-attempt-ledger-reuse-source";
  const sourceEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: sourceWorkflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(sourceWorkflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 }
    ])
  });
  const sourceRun = await startRun({ projectRoot: project, runId: "attempt-ledger-reuse-source", env: sourceEnv });
  assert.equal(sourceRun.ok, true, JSON.stringify(sourceRun.diagnostics));
  writeRequiredArtifactSet(sourceRun.value!.run_root, "project-discovery", [
    "setup/project-discovery.md",
    "findings.json"
  ]);
  const sourceSync = await syncRun({ projectRoot: project, runId: "attempt-ledger-reuse-source", env: sourceEnv });
  assert.equal(sourceSync.ok, true, JSON.stringify(sourceSync.diagnostics));
  const sourceAttempt = JSON.parse(
    fs.readFileSync(path.join(sourceRun.value!.run_root, "attempts.jsonl"), "utf8").trim()
  ) as Record<string, unknown>;

  const workflowRunId = "ultrafuzz-attempt-ledger-reused-override";
  const firstReuseEvents = [
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
    { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "reused-from-prior-run", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, firstReuseEvents)
  });
  const run = await startRun({
    projectRoot: project,
    runId: "attempt-ledger-reused-override",
    sourceRunId: "attempt-ledger-reuse-source",
    env
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "attempt-ledger-reused-override", env });
  const replayed = await syncRun({ projectRoot: project, runId: "attempt-ledger-reused-override", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.ok(!sync.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  assert.ok(!replayed.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));

  const ledger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const reuse = ledger[0]?.reuse as Record<string, unknown> | undefined;
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.outcome, "reused");
  assert.equal(ledger[0]?.failure_category, undefined);
  assert.equal(reuse?.status, "reused");
  assert.equal(reuse?.source_attempt_id, sourceAttempt.attempt_id);
  assert.notEqual(reuse?.source_attempt_id, ledger[0]?.attempt_id);

  const continuedEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "reused-from-prior-run", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      ...firstReuseEvents,
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 }
    ])
  });
  const continued = await syncRun({
    projectRoot: project,
    runId: "attempt-ledger-reused-override",
    env: continuedEnv
  });
  assert.equal(continued.ok, true, JSON.stringify(continued.diagnostics));
  assert.ok(!continued.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  const continuedLedger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(continuedLedger.length, 2);
  assert.deepEqual(
    continuedLedger.map((entry) => (entry.reuse as Record<string, unknown>).source_attempt_id),
    [sourceAttempt.attempt_id, sourceAttempt.attempt_id]
  );

  const status = await getRunStatus({
    projectRoot: project,
    runId: "attempt-ledger-reused-override",
    env: continuedEnv
  });
  assert.equal(status.ok, true, JSON.stringify(status.diagnostics));
  assert.equal(status.value?.attempts.reused, 2);
});

test("syncRun keeps reset workflow nodes pending while the workflow is running", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-reset-pending";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        error: { message: "CLI timed out after 1800000ms" }
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-reset-pending", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-reset-pending", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    status?: string;
    finished_at?: string;
    nodes?: Record<string, { status?: string; last_error?: string; finished_at?: string; timed_out?: boolean }>;
  };
  assert.equal(state.status, "running");
  assert.equal(state.finished_at, undefined);
  assert.equal(state.nodes?.["project-discovery"]?.status, "pending");
  assert.equal(state.nodes?.["project-discovery"]?.timed_out, false);
  assert.equal(state.nodes?.["project-discovery"]?.last_error, undefined);
  assert.equal(state.nodes?.["project-discovery"]?.finished_at, undefined);
});

test("syncRun records external wait reasons from workflow events", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-wait-event-run";
  const afterInspection = Date.parse("2026-07-03T00:00:04.000Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodePending", nodeId: "node:project-discovery", attempt: 1 },
      {
        type: "NodeWaitingApproval",
        nodeId: "node:project-discovery",
        attempt: 1,
        timestampMs: afterInspection
      }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "wait-event-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun(
    { projectRoot: project, runId: "wait-event-run", env },
    { now: () => Date.parse("2026-07-03T00:00:03.000Z") }
  );

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as RunState;
  assert.equal(state.nodes["project-discovery"]?.wait_reason, "approval");
  assert.equal(state.nodes["project-discovery"]?.next_eligible_action, "approve");
});

test("syncRun cancels a nonterminal workflow at its durable workflow deadline", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-deadline-run";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 0 }]
    }),
    events: workflowEvents(workflowRunId, [{ type: "NodePending", nodeId: "node:project-discovery", attempt: 0 }])
  });
  const run = await startRun({ projectRoot: project, runId: "deadline-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const statePath = path.join(run.value!.run_root, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as RunState;
  state.workflow_deadline_at = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const sync = await syncRun({ projectRoot: project, runId: "deadline-run", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "timed-out");
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as RunState;
  assert.equal(persisted.status, "timed-out");
  assert.equal(typeof persisted.finished_at, "string");
  assert.match(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /cancel ultrafuzz-deadline-run --format json/u);
  assert.match(fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8"), /workflow-deadline-exceeded/u);

  fs.writeFileSync(
    env.SMITHERS_FAKE_INSPECT!,
    `${JSON.stringify(
      workflowInspect({
        workflowRunId,
        status: "canceled",
        state: "canceled",
        steps: [{ id: "node:project-discovery", state: "pending", attempt: 0 }]
      })
    )}\n`,
    "utf8"
  );
  const acknowledged = await syncRun({ projectRoot: project, runId: "deadline-run", env });

  assert.equal(acknowledged.ok, true, JSON.stringify(acknowledged.diagnostics));
  assert.equal(acknowledged.value?.status, "timed-out");
  assert.equal((fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8").match(/^cancel /gmu) ?? []).length, 1);
});

test("syncRun bounds a blocked durable-deadline cancellation by its overall deadline", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "deadline-blocked-cancel";
  const workflowRunId = `ultrafuzz-${runId}`;
  const cancelStarted = path.join(project, "cancel-started");
  const cancelRelease = path.join(project, "cancel-release");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 0 }]
    }),
    events: workflowEvents(workflowRunId, [{ type: "NodePending", nodeId: "node:project-discovery", attempt: 0 }]),
    cancelStartedMarkerPath: cancelStarted,
    cancelReleaseMarkerPath: cancelRelease
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const statePath = path.join(run.value!.run_root, "state.json");
  const eventsPath = path.join(run.value!.run_root, "events.jsonl");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as RunState;
  state.workflow_deadline_at = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const stateBefore = fs.readFileSync(statePath, "utf8");
  const eventsBefore = fs.readFileSync(eventsPath, "utf8");

  const logicalStartedAt = Date.now();
  const sync = await syncRun(
    { projectRoot: project, runId, env },
    {
      // Hold the deterministic synchronization clock steady through the prompt
      // inspection commands, then cross the deadline after cancel has received
      // the exact remaining subprocess budget.
      now: () => (fs.existsSync(cancelStarted) ? logicalStartedAt + 251 : logicalStartedAt),
      deadlineMs: logicalStartedAt + 250
    }
  );
  const cancelElapsedMs = Date.now() - fs.statSync(cancelStarted).mtimeMs;

  assert.equal(sync.ok, false);
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED"));
  // Integrity and inspection work before cancellation is intentionally driven
  // by the injected synchronization clock and varies with host load. Measure
  // the blocked cancellation itself from the child-owned marker so this proves
  // the 250 ms command budget plus bounded termination grace without a flaky
  // ceiling on unrelated preflight work.
  assert.ok(cancelElapsedMs >= 0 && cancelElapsedMs < 1_500, `cancel_elapsed_ms=${cancelElapsedMs}`);
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as RunState;
  const stateBeforeDocument = JSON.parse(stateBefore) as RunState;
  assert.equal(persisted.status, "running");
  assert.equal(persisted.finished_at, stateBeforeDocument.finished_at);
  assert.equal(persisted.nodes["project-discovery"]?.timed_out, false);
  assert.equal(fs.readFileSync(eventsPath, "utf8"), eventsBefore);
  assert.equal(fs.existsSync(cancelRelease), false);
  assert.equal(fs.existsSync(cancelStarted), true);

  const cancelPid = Number(fs.readFileSync(cancelStarted, "utf8").trim());
  assert.ok(Number.isSafeInteger(cancelPid) && cancelPid > 0);
  let cancelChildExited = false;
  const childExitDeadline = Date.now() + 1_000;
  while (Date.now() < childExitDeadline) {
    try {
      process.kill(cancelPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        cancelChildExited = true;
        break;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(cancelChildExited, true, `cancel child ${cancelPid} remained alive`);
});

test("syncRun records model fan-out attempts independently", async () => {
  const project = tempProject();
  writeFanoutProject(project);
  const workflowRunId = "ultrafuzz-sync-fanout";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [
        { id: "node:project-discovery__model_0__attempt_0", state: "finished", attempt: 1 },
        { id: "node:project-discovery__model_1__attempt_1", state: "failed", attempt: 1 },
        { id: "node:signal-analysis__model_0__attempt_0", state: "in-progress", attempt: 1 },
        { id: "node:signal-analysis__model_1__attempt_1", state: "skipped", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery__model_0__attempt_0", attempt: 1 },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery__model_1__attempt_1",
        attempt: 1,
        error: { message: "model failed" }
      },
      { type: "NodeStarted", nodeId: "node:signal-analysis__model_0__attempt_0", attempt: 1 },
      { type: "NodeSkipped", nodeId: "node:signal-analysis__model_1__attempt_1", attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-fanout", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery__model_0__attempt_0", [
    "setup/project-discovery.md",
    "findings.json"
  ]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-fanout", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      {
        status?: string;
        provenance?: {
          failure?: {
            category?: string;
            causal_task_id?: string;
            causal_failure_category?: string;
            dependent_task_ids?: string[];
          };
        };
      }
    >;
  };
  assert.equal(state.nodes?.["project-discovery__model_0__attempt_0"]?.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery__model_1__attempt_1"]?.status, "failed");
  assert.equal(state.nodes?.["signal-analysis__model_0__attempt_0"]?.status, "running");
  assert.equal(state.nodes?.["signal-analysis__model_1__attempt_1"]?.status, "skipped");
  assert.deepEqual(state.nodes?.["signal-analysis__model_1__attempt_1"]?.provenance?.failure, {
    category: "dependency-cascade",
    causal_task_id: "node:project-discovery__model_1__attempt_1",
    causal_failure_category: "agent-failure",
    dependent_task_ids: ["node:signal-analysis__model_1__attempt_1"]
  });
  assert.equal(state.nodes?.["project-discovery"]?.status, "failed");
  const aggregateEvents = replayEvents(layoutForRunRoot(run.value!.run_root), Number.MAX_SAFE_INTEGER).records.filter(
    (event) => event.node_id === "project-discovery" && event.event_type === "node-synced"
  );
  assert.equal(aggregateEvents.length, 1);
  assert.deepEqual(aggregateEvents[0]?.payload, {
    workflow_run_id: workflowRunId,
    previous_status: "pending",
    aggregate_attempt_ids: ["project-discovery__model_0__attempt_0", "project-discovery__model_1__attempt_1"],
    aggregate_attempt_statuses: ["succeeded", "failed"]
  });
  assert.equal(
    fs.existsSync(
      path.join(run.value!.run_root, "artifacts", "project-discovery__model_0__attempt_0", "artifact-manifest.json")
    ),
    true
  );
  const ledger = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const projectDiscoveryAttempts = ledger.filter((entry) => entry.node_id === "project-discovery");
  assert.equal(projectDiscoveryAttempts.length, 2);
  assert.deepEqual(projectDiscoveryAttempts.map((entry) => entry.strategy_attempt_id).sort(), [
    "project-discovery__model_0__attempt_0",
    "project-discovery__model_1__attempt_1"
  ]);
});

test("syncRun crash-recovers aggregate fan-out state and evidence exactly once", async () => {
  for (const fault of ["after-events", "after-state"] as const) {
    const project = tempProject();
    writeFanoutProject(project);
    const runId = `sync-fanout-aggregate-${fault}`;
    const workflowRunId = `ultrafuzz-${runId}`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId,
        status: "failed",
        state: "failed",
        steps: [
          { id: "node:project-discovery__model_0__attempt_0", state: "finished", attempt: 1 },
          { id: "node:project-discovery__model_1__attempt_1", state: "failed", attempt: 1 },
          { id: "node:signal-analysis__model_0__attempt_0", state: "in-progress", attempt: 1 },
          { id: "node:signal-analysis__model_1__attempt_1", state: "skipped", attempt: 1 }
        ]
      }),
      events: workflowEvents(workflowRunId, [
        { type: "NodeFinished", nodeId: "node:project-discovery__model_0__attempt_0", attempt: 1 },
        {
          type: "NodeFailed",
          nodeId: "node:project-discovery__model_1__attempt_1",
          attempt: 1,
          error: { message: "model failed" }
        },
        { type: "NodeStarted", nodeId: "node:signal-analysis__model_0__attempt_0", attempt: 1 },
        { type: "NodeSkipped", nodeId: "node:signal-analysis__model_1__attempt_1", attempt: 1 }
      ])
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, `${fault}: ${JSON.stringify(run.diagnostics)}`);
    writeRequiredArtifactSet(run.value!.run_root, "project-discovery__model_0__attempt_0", [
      "setup/project-discovery.md",
      "findings.json"
    ]);
    const layout = layoutForRunRoot(run.value!.run_root);
    const aggregateIndex = path.join(layout.eventsIndexDir, "node", "project-discovery.jsonl");
    let aggregateEventId: string | undefined;
    let statusInFaultWindow: string | undefined;
    let injected = false;
    const inject = () => {
      if (injected) return;
      const prepared = JSON.parse(fs.readFileSync(workflowSyncCommitJournalPath(layout), "utf8")) as {
        phase?: string;
        events?: Array<{ event_id?: string; event_type?: string; node_id?: string }>;
      };
      const aggregateEvent = prepared.events?.find(
        (event) => event.event_type === "node-synced" && event.node_id === "project-discovery"
      );
      if (aggregateEvent === undefined) return;
      injected = true;
      aggregateEventId = aggregateEvent.event_id;
      assert.equal(prepared.phase, "prepared", fault);
      statusInFaultWindow = readRunState(layout).nodes["project-discovery"]?.status;
      fs.rmSync(aggregateIndex);
      throw new Error(`injected aggregate ${fault} synchronization fault`);
    };

    await assert.rejects(
      syncRun(
        { projectRoot: project, runId, env },
        fault === "after-events" ? { afterEventsPersisted: inject } : { afterStatePersisted: inject }
      ),
      new RegExp(`injected aggregate ${fault} synchronization fault`, "u")
    );
    assert.equal(injected, true, fault);
    assert.equal(statusInFaultWindow, fault === "after-state" ? "failed" : "pending", fault);
    assert.equal(readRunState(layout).nodes["project-discovery"]?.status, "failed", fault);
    const eventId = aggregateEventId;
    if (eventId === undefined) throw new Error(`${fault}: aggregate node-synced event was not prepared`);

    const release = await acquireWorkflowMutationLock(layout);
    await release();
    assert.equal(readRunState(layout).nodes["project-discovery"]?.status, "failed", fault);
    for (const eventPath of [layout.eventsPath, aggregateIndex]) {
      const occurrences: number = fs
        .readFileSync(eventPath, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line.includes(eventId)).length;
      assert.equal(occurrences, 1, `${fault}: ${eventPath}`);
    }

    const secondRelease = await acquireWorkflowMutationLock(layout);
    await secondRelease();
    assert.equal(
      replayEvents(layout, Number.MAX_SAFE_INTEGER).records.filter((event) => event.event_id === eventId).length,
      1,
      fault
    );
  }
});

test("resume, replay, and fork delegate linked runs to Smithers lifecycle verbs", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project, { inspectState: "failed" });
  const run = await startRun({ projectRoot: project, runId: "lifecycle-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const baselineSnapshots = workflowExecutionSnapshotCount(run.value!.run_root);
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  const staleStatePath = path.join(run.value!.run_root, "state.json");
  const staleState = JSON.parse(fs.readFileSync(staleStatePath, "utf8")) as RunState;
  staleState.workflow_deadline_at = "2000-01-01T00:00:00.000Z";
  staleState.status = "timed-out";
  staleState.finished_at = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(staleStatePath, `${JSON.stringify(staleState, null, 2)}\n`, "utf8");
  const resumeSubmittedAfterMs = Date.now();

  const resumed = await resumeRun({ projectRoot: project, runId: run.value!.run_id, maxConcurrency: 8, env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.workflow_run_id, "ultrafuzz-lifecycle-run");
  assert.equal(resumed.value?.submitted, true);
  const resumedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as RunState;
  assert.equal(resumedState.concurrency.requested_concurrency, 8);
  assert.equal(resumedState.controller_lease.duration_ms, 30_000);
  assert.equal(resumedState.status, "running");
  assert.equal(resumedState.finished_at, undefined);
  assert.notEqual(resumedState.workflow_deadline_at, "2000-01-01T00:00:00.000Z");
  assert.ok(Date.parse(resumedState.workflow_deadline_at ?? "") > resumeSubmittedAfterMs);
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots + 1);

  const resetResumed = await resumeRun({
    projectRoot: project,
    runId: run.value!.run_id,
    maxConcurrency: 8,
    resetNode: "node:project-discovery",
    env
  });
  assert.equal(resetResumed.ok, true, JSON.stringify(resetResumed.diagnostics));
  assert.equal(resetResumed.value?.submitted, true);
  const cloudGeneration = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "cloud-execution-generation.json"), "utf8")
  ) as { generation?: string; reset_node?: string };
  assert.match(cloudGeneration.generation ?? "", /^[0-9a-f-]{36}$/u);
  assert.equal(cloudGeneration.reset_node, "node:project-discovery");
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots + 2);

  const missingReplayFrame = await replayRun({ projectRoot: project, runId: run.value!.run_id, env });
  assert.equal(missingReplayFrame.ok, false);
  assert.equal(missingReplayFrame.diagnostics[0]?.code, "WORKFLOW_REPLAY_FRAME_REQUIRED");
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots + 2);

  const replayed = await replayRun({
    projectRoot: project,
    runId: run.value!.run_id,
    forkFrame: 33,
    maxConcurrency: 6,
    env
  });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.equal(replayed.value?.workflow_run_id, "ultrafuzz-lifecycle-run-replayed");
  assert.equal(replayed.value?.submitted, true);
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots + 3);

  const missingFrame = await forkRun({ projectRoot: project, runId: run.value!.run_id, env });
  assert.equal(missingFrame.ok, false);
  assert.equal(missingFrame.diagnostics[0]?.code, "WORKFLOW_FORK_FRAME_REQUIRED");
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots + 3);

  const forked = await forkRun({
    projectRoot: project,
    runId: run.value!.run_id,
    forkFrame: 44,
    resetNode: "node:project-discovery",
    label: "after-edit",
    maxConcurrency: 8,
    env
  });
  assert.equal(forked.ok, true, JSON.stringify(forked.diagnostics));
  assert.equal(forked.value?.workflow_run_id, "ultrafuzz-lifecycle-run-forked");
  assert.equal(forked.value?.submitted, true);
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots + 4);
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    workflow?: { run_id?: string };
    workflow_ids?: string[];
  };
  assert.equal(metadata.workflow?.run_id, "ultrafuzz-lifecycle-run-forked");
  assert.deepEqual(metadata.workflow_ids, ["ultrafuzz-lifecycle-run-forked"]);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, new RegExp(`/proc/${process.pid}/fd/[0-9]+/\\.smithers/workflows/`, "u"));
  assert.doesNotMatch(commands, /\/smithers\/execution-snapshots\/[0-9a-f]+-[^/]+\/\.smithers\/workflows\//u);
  assert.equal(commands.includes(path.join(project, ".smithers", "workflows")), false);
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run --run-id ultrafuzz-lifecycle-run --detach --max-concurrency 8 --format json/
  );
  assert.match(
    commands,
    /timetravel .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run --node-id node:project-discovery --no-vcs --force --format json/
  );
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run --run-id ultrafuzz-lifecycle-run --force --detach --max-concurrency 8 --format json/
  );
  assert.match(
    commands,
    /replay .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run --frame 33 --label ultrafuzz-lifecycle-[0-9a-f]{64} --ultrafuzz-prepare-only --format json/
  );
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run-replayed --run-id ultrafuzz-lifecycle-run-replayed --force --detach --max-concurrency 6 --format json --supervise --supervise-interval 10s --supervise-stale-threshold 30s --supervise-max-concurrent 1/
  );
  assert.match(
    commands,
    /fork .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run-replayed --frame 44 --reset-node node:project-discovery --label after-edit--ultrafuzz-lifecycle-[0-9a-f]{64} --ultrafuzz-prepare-only --format json/
  );
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run-forked --run-id ultrafuzz-lifecycle-run-forked --force --detach --max-concurrency 8 --format json/
  );
  const actionJournal = JSON.parse(
    fs.readFileSync(workflowLifecycleActionJournalPath(layoutForRunRoot(run.value!.run_root)), "utf8")
  ) as { entries?: Array<{ action?: string; action_id?: string; fork_frame?: number; label?: string }> };
  const replayAction = actionJournal.entries?.find((entry) => entry.action === "replay");
  const forkAction = actionJournal.entries?.find((entry) => entry.action === "fork");
  assert.equal(typeof replayAction?.action_id, "string");
  assert.equal(replayAction?.fork_frame, 33);
  assert.equal(typeof forkAction?.action_id, "string");
  assert.equal(forkAction?.label, "after-edit");
  assert.ok(commands.includes(`--label ${workflowLifecycleCorrelationLabel(replayAction!.action_id!)}`));
  assert.ok(commands.includes(`--label ${workflowLifecycleCorrelationLabel(forkAction!.action_id!, "after-edit")}`));
  assert.equal(
    workflowLifecycleCorrelationLabel(forkAction!.action_id!, "after-edit").startsWith("after-edit--"),
    true
  );
  assert.ok(
    commands.indexOf("replay ") < commands.indexOf("up ", commands.indexOf("replay ")),
    "replay preparation must precede its detached resume"
  );
});

test("fork and replay reject invalid checkpoint frames before journaling or invocation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "invalid-lifecycle-frames";
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  const baselineSnapshots = workflowExecutionSnapshotCount(run.value!.run_root);
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  for (const frame of [-1, 1.5, Number.NaN, WORKFLOW_CHECKPOINT_FRAME_MAX + 1, Number.MAX_SAFE_INTEGER + 1]) {
    const replayed = await replayRun({ projectRoot: project, runId, forkFrame: frame, env });
    assert.equal(replayed.ok, false, String(frame));
    assert.equal(replayed.diagnostics[0]?.code, "WORKFLOW_REPLAY_FRAME_INVALID", String(frame));
    const forked = await forkRun({ projectRoot: project, runId, forkFrame: frame, env });
    assert.equal(forked.ok, false, String(frame));
    assert.equal(forked.diagnostics[0]?.code, "WORKFLOW_FORK_FRAME_INVALID", String(frame));
  }

  assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), "");
  assert.equal(fs.existsSync(workflowLifecycleActionJournalPath(layout)), false);
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots);
});

test("a nonexistent replay frame fails before effects and a later valid frame remains retryable", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "lifecycle-run";
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  const baselineSnapshots = workflowExecutionSnapshotCount(run.value!.run_root);
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const missing = await replayRun({ projectRoot: project, runId, forkFrame: 8, env });

  assert.equal(missing.ok, false);
  assert.match(missing.diagnostics[0]?.message ?? "", /frame 8 does not exist/u);
  assert.doesNotMatch(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /^replay\b/mu);
  assert.equal(fs.existsSync(workflowLifecycleActionJournalPath(layout)), false);
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots);

  const retried = await replayRun({ projectRoot: project, runId, forkFrame: 7, env });

  assert.equal(retried.ok, true, JSON.stringify(retried.diagnostics));
  assert.equal(retried.value?.workflow_run_id, "ultrafuzz-lifecycle-run-replayed");
  assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8").match(/^replay\b/gmu)?.length, 1);
});

test("fork and replay reject an unrelated returned workflow ID before committing or starting its link", async () => {
  for (const action of ["fork", "replay"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `${action}-unrelated-return`;
    const sourceWorkflowRunId = `ultrafuzz-${runId}`;
    const correlatedChildRunId = `${sourceWorkflowRunId}-correlated`;
    const unrelatedRunId = `${sourceWorkflowRunId}-unrelated`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({ workflowRunId: sourceWorkflowRunId, steps: [] }),
      timeline: {
        data: { timeline: { runId: sourceWorkflowRunId, frames: [{ frameNo: 7, forks: [] }], children: [] } }
      },
      ...(action === "fork"
        ? { forkRunId: unrelatedRunId, forkTimelineRunId: correlatedChildRunId }
        : { replayRunId: unrelatedRunId, replayTimelineRunId: correlatedChildRunId })
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const layout = layoutForRunRoot(run.value!.run_root);
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

    const rejected =
      action === "fork"
        ? await forkRun({ projectRoot: project, runId, forkFrame: 7, env })
        : await replayRun({ projectRoot: project, runId, forkFrame: 7, env });

    assert.equal(rejected.ok, false, action);
    assert.match(rejected.diagnostics[0]?.message ?? "", /unique exact correlated direct child/u, action);
    assert.equal(verifyCommittedWorkflowRunLink(layout).workflow_run_id, sourceWorkflowRunId, action);
    const journal = JSON.parse(fs.readFileSync(workflowLifecycleActionJournalPath(layout), "utf8")) as {
      entries?: Array<{ phase?: string; external_workflow_run_id?: string }>;
    };
    assert.equal(journal.entries?.at(-1)?.phase, "reconciliation-pending", action);
    assert.equal(journal.entries?.at(-1)?.external_workflow_run_id, undefined, action);
    assert.doesNotMatch(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /^up\b/mu, action);
  }
});

test("replay reconciliation resumes a prepared child from its exact retained execution snapshot", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "replay-retained-execution-snapshot";
  const sourceWorkflowRunId = `ultrafuzz-${runId}`;
  const correlatedChildRunId = `${sourceWorkflowRunId}-correlated`;
  const unrelatedReturnedRunId = `${sourceWorkflowRunId}-unrelated-return`;
  const persistedPathLog = path.join(project, "persisted-workflow-paths.log");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({ workflowRunId: sourceWorkflowRunId, steps: [] }),
    timeline: {
      data: { timeline: { runId: sourceWorkflowRunId, frames: [{ frameNo: 7, forks: [] }], children: [] } }
    },
    replayRunId: unrelatedReturnedRunId,
    replayTimelineRunId: correlatedChildRunId,
    persistedWorkflowPathLog: persistedPathLog
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  const baselineSnapshots = workflowExecutionSnapshotCount(layout.root);
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  fs.writeFileSync(persistedPathLog, "", "utf8");

  const rejected = await replayRun({ projectRoot: project, runId, forkFrame: 7, env });

  assert.equal(rejected.ok, false);
  assert.equal(workflowExecutionSnapshotCount(layout.root), baselineSnapshots + 1);
  const invoking = [...replayEvents(layout, Number.MAX_SAFE_INTEGER).records]
    .reverse()
    .find(
      (event) => event.event_type === "workflow-lifecycle-invoking" && eventPayload(event.payload).action === "replay"
    );
  assert.ok(invoking);
  const retainedRoot = eventPayload(invoking.payload).execution_snapshot_root;
  assert.equal(typeof retainedRoot, "string");
  assert.equal(fs.existsSync(retainedRoot as string), true);
  const retainedWorkflowPath = path.join(
    retainedRoot as string,
    ".smithers",
    "workflows",
    `${sourceWorkflowRunId}.tsx`
  );
  const preparationPaths = fs
    .readFileSync(persistedPathLog, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("replay "))
    .map((line) => line.slice(line.lastIndexOf("|") + 1));
  assert.deepEqual(preparationPaths, [retainedWorkflowPath]);

  fs.writeFileSync(
    env.SMITHERS_FAKE_INSPECT!,
    `${JSON.stringify(
      workflowInspect({ workflowRunId: correlatedChildRunId, status: "failed", state: "failed", steps: [] }),
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  fs.writeFileSync(persistedPathLog, "", "utf8");

  const reconciled = await replayRun({ projectRoot: project, runId, forkFrame: 7, env });

  assert.equal(reconciled.ok, true, JSON.stringify(reconciled.diagnostics));
  assert.equal(reconciled.value?.workflow_run_id, correlatedChildRunId);
  assert.equal(workflowExecutionSnapshotCount(layout.root), baselineSnapshots + 1);
  assert.equal(fs.existsSync(retainedRoot as string), true);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.doesNotMatch(commands, /^replay\b/mu);
  assert.match(commands, new RegExp(`^up .* --resume ${correlatedChildRunId} `, "mu"));
  const reconciliationPaths = fs
    .readFileSync(persistedPathLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("|") + 1));
  assert.ok(reconciliationPaths.length > 0);
  assert.deepEqual([...new Set(reconciliationPaths)], [retainedWorkflowPath]);
});

test(
  "a definitive replay pre-spawn failure retires its journal entry and allows an exact retry",
  { concurrency: false },
  async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = "replay-pre-spawn-retry";
    const sourceWorkflowRunId = `ultrafuzz-${runId}`;
    const childWorkflowRunId = `${sourceWorkflowRunId}-child`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({ workflowRunId: sourceWorkflowRunId, steps: [] }),
      timeline: {
        data: { timeline: { runId: sourceWorkflowRunId, frames: [{ frameNo: 9, forks: [] }], children: [] } }
      },
      replayRunId: childWorkflowRunId
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const layout = layoutForRunRoot(run.value!.run_root);
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

    const originalOpenSync = fs.openSync;
    let injected = false;
    fs.openSync = ((filePath, flags, mode) => {
      if (
        !injected &&
        String(filePath) === path.join(layout.root, "smithers", "execution-snapshots") &&
        fs.existsSync(workflowLifecycleActionJournalPath(layout))
      ) {
        const journal = JSON.parse(fs.readFileSync(workflowLifecycleActionJournalPath(layout), "utf8")) as {
          entries?: Array<{ phase?: string }>;
        };
        if (journal.entries?.at(-1)?.phase === "invoking") {
          injected = true;
          const error = new Error("injected snapshot-anchor failure") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
      }
      return originalOpenSync(filePath, flags, mode);
    }) as typeof fs.openSync;
    let failed: Awaited<ReturnType<typeof replayRun>>;
    try {
      failed = await replayRun({ projectRoot: project, runId, forkFrame: 9, env });
    } finally {
      fs.openSync = originalOpenSync;
    }

    assert.equal(injected, true);
    assert.equal(failed.ok, false);
    assert.match(failed.diagnostics[0]?.message ?? "", /injected snapshot-anchor failure/u);
    let journal = JSON.parse(fs.readFileSync(workflowLifecycleActionJournalPath(layout), "utf8")) as {
      entries?: Array<{ phase?: string; fork_frame?: number }>;
    };
    assert.equal(journal.entries?.at(-1)?.phase, "failed");
    assert.equal(journal.entries?.at(-1)?.fork_frame, 9);
    assert.doesNotMatch(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /^replay\b/mu);

    const retried = await replayRun({ projectRoot: project, runId, forkFrame: 9, env });

    assert.equal(retried.ok, true, JSON.stringify(retried.diagnostics));
    assert.equal(retried.value?.workflow_run_id, childWorkflowRunId);
    assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8").match(/^replay\b/gmu)?.length, 1);
    journal = JSON.parse(fs.readFileSync(workflowLifecycleActionJournalPath(layout), "utf8")) as {
      entries?: Array<{ phase?: string; fork_frame?: number }>;
    };
    assert.deepEqual(
      journal.entries?.map((entry) => [entry.phase, entry.fork_frame]),
      [
        ["failed", 9],
        ["reconciled", 9]
      ]
    );
  }
);

test("a replay failure after successful spawn remains reconciliation-fenced", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "replay-post-spawn-fenced";
  const sourceWorkflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({ workflowRunId: sourceWorkflowRunId, steps: [] }),
    timeline: {
      data: { timeline: { runId: sourceWorkflowRunId, frames: [{ frameNo: 11, forks: [] }], children: [] } }
    },
    replayExitCode: 42
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const failed = await replayRun({ projectRoot: project, runId, forkFrame: 11, env });
  const repeated = await replayRun({ projectRoot: project, runId, forkFrame: 11, env });

  assert.equal(failed.ok, false);
  assert.equal(repeated.ok, false);
  assert.match(repeated.diagnostics[0]?.message ?? "", /will not be repeated/u);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.equal(commands.match(/^replay\b/gmu)?.length, 1);
  const journal = JSON.parse(fs.readFileSync(workflowLifecycleActionJournalPath(layout), "utf8")) as {
    entries?: Array<{ phase?: string; fork_frame?: number }>;
  };
  assert.equal(journal.entries?.at(-1)?.phase, "reconciliation-pending");
  assert.equal(journal.entries?.at(-1)?.fork_frame, 11);
});

test("fork and replay reconcile a durably returned external run without repeating the non-idempotent action", async () => {
  for (const action of ["fork", "replay"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `journal-${action}`;
    const sourceWorkflowRunId = `ultrafuzz-${runId}`;
    const childWorkflowRunId = `${sourceWorkflowRunId}-${action}-child`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({ workflowRunId: sourceWorkflowRunId, steps: [] })
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const layout = layoutForRunRoot(run.value!.run_root);
    const entry = prepareWorkflowLifecycleAction(layout, {
      action,
      sourceWorkflowRunId,
      sourceWorkflowLinkId: verifyCommittedWorkflowRunLink(layout).link_id,
      controlGeneration: workflowControlGeneration(project, layout),
      knownWorkflowRunIds: [sourceWorkflowRunId],
      forkFrame: 7
    });
    const invoking = appendEvent(layout, {
      eventType: "workflow-lifecycle-invoking",
      status: "running",
      payload: {
        action,
        workflow_run_id: sourceWorkflowRunId,
        control_generation: workflowControlGeneration(project, layout),
        workflow_link_id: verifyCommittedWorkflowRunLink(layout).link_id,
        lifecycle_action_id: entry.action_id
      }
    });
    transitionWorkflowLifecycleAction(layout, entry.action_id, "invoking", {
      controller_invocation_id: invoking.event_id,
      controller_invoked_at: invoking.timestamp
    });
    transitionWorkflowLifecycleAction(layout, entry.action_id, "external-result", {
      external_workflow_run_id: childWorkflowRunId,
      external_result_at: new Date().toISOString()
    });
    const branchLabel = workflowLifecycleCorrelationLabel(entry.action_id);
    fs.writeFileSync(
      env.SMITHERS_FAKE_TIMELINE!,
      `${JSON.stringify(
        {
          data: {
            timeline: {
              runId: sourceWorkflowRunId,
              frames: [{ frameNo: 7, forks: [{ runId: childWorkflowRunId, branchLabel }] }],
              children: [{ runId: childWorkflowRunId, branch: branchLabel, frames: [], children: [] }]
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    fs.writeFileSync(
      env.SMITHERS_FAKE_INSPECT!,
      `${JSON.stringify(workflowInspect({ workflowRunId: childWorkflowRunId, steps: [] }), null, 2)}\n`,
      "utf8"
    );
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

    const reconciled =
      action === "fork"
        ? await forkRun({ projectRoot: project, runId, forkFrame: 7, env })
        : await replayRun({ projectRoot: project, runId, forkFrame: 7, env });

    assert.equal(reconciled.ok, true, JSON.stringify(reconciled.diagnostics));
    assert.equal(reconciled.value?.workflow_run_id, childWorkflowRunId);
    const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
    assert.doesNotMatch(commands, new RegExp(`^${action}\\b`, "mu"));
    assert.match(commands, new RegExp(`^up .* --resume ${childWorkflowRunId} `, "mu"));
    const journal = JSON.parse(fs.readFileSync(workflowLifecycleActionJournalPath(layout), "utf8")) as {
      entries?: Array<{ action_id?: string; phase?: string; external_workflow_run_id?: string }>;
    };
    const durable = journal.entries?.find((candidate) => candidate.action_id === entry.action_id);
    assert.equal(durable?.phase, "reconciled");
    assert.equal(durable?.external_workflow_run_id, childWorkflowRunId);
    const metadata = JSON.parse(fs.readFileSync(layout.runMetadataPath, "utf8")) as {
      workflow?: { run_id?: string };
    };
    assert.equal(metadata.workflow?.run_id, childWorkflowRunId);
  }
});

test(
  "reconciliation of an already-active linked child issues no replacement up submission",
  { concurrency: false },
  async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = "active-reconciled-child";
    const sourceWorkflowRunId = `ultrafuzz-${runId}`;
    const childWorkflowRunId = `${sourceWorkflowRunId}-child`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId: childWorkflowRunId,
        status: "running",
        state: "running",
        steps: [{ id: "node:project-discovery", state: "running", attempt: 1 }]
      })
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const layout = layoutForRunRoot(run.value!.run_root);
    const sourceLink = verifyCommittedWorkflowRunLink(layout);
    const entry = prepareWorkflowLifecycleAction(layout, {
      action: "replay",
      sourceWorkflowRunId,
      sourceWorkflowLinkId: sourceLink.link_id,
      controlGeneration: workflowControlGeneration(project, layout),
      knownWorkflowRunIds: [sourceWorkflowRunId],
      forkFrame: 7
    });
    const invoking = appendEvent(layout, {
      eventType: "workflow-lifecycle-invoking",
      status: "running",
      payload: {
        action: "replay",
        workflow_run_id: sourceWorkflowRunId,
        workflow_link_id: sourceLink.link_id,
        control_generation: workflowControlGeneration(project, layout),
        lifecycle_action_id: entry.action_id
      }
    });
    transitionWorkflowLifecycleAction(layout, entry.action_id, "invoking", {
      controller_invocation_id: invoking.event_id,
      controller_invoked_at: invoking.timestamp
    });
    transitionWorkflowLifecycleAction(layout, entry.action_id, "external-result", {
      external_workflow_run_id: childWorkflowRunId,
      external_result_at: new Date().toISOString()
    });
    const branchLabel = workflowLifecycleCorrelationLabel(entry.action_id);
    fs.writeFileSync(
      env.SMITHERS_FAKE_TIMELINE!,
      `${JSON.stringify(
        {
          data: {
            timeline: {
              runId: sourceWorkflowRunId,
              frames: [
                {
                  frameNo: 7,
                  forks: [{ runId: childWorkflowRunId, branchLabel }]
                }
              ],
              children: [
                { runId: childWorkflowRunId, branch: branchLabel, frames: [{ frameNo: 0, forks: [] }], children: [] }
              ]
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

    const disposalClosures: Array<{ eventType: string | undefined; journalPhase: string | undefined }> = [];
    const reconciled = await observeWorkflowExecutionSnapshotDisposals(
      layout.root,
      () => replayRun({ projectRoot: project, runId, forkFrame: 7, env }),
      () => {
        const latestEvent = replayEvents(layout, Number.MAX_SAFE_INTEGER).records.at(-1);
        const journal = JSON.parse(fs.readFileSync(workflowLifecycleActionJournalPath(layout), "utf8")) as {
          entries?: Array<{ action_id?: string; phase?: string }>;
        };
        disposalClosures.push({
          eventType: latestEvent?.event_type,
          journalPhase: journal.entries?.find((candidate) => candidate.action_id === entry.action_id)?.phase
        });
      }
    );

    assert.equal(reconciled.ok, true, JSON.stringify(reconciled.diagnostics));
    assert.equal(reconciled.value?.workflow_run_id, childWorkflowRunId);
    assert.equal(reconciled.value?.submitted, false);
    const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
    assert.match(commands, new RegExp(`^inspect ${childWorkflowRunId} --format json$`, "mu"));
    assert.doesNotMatch(commands, /^up\b/mu);
    const lifecycleEvents = fs
      .readFileSync(path.join(layout.root, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event_type?: string });
    assert.equal(lifecycleEvents.filter((event) => event.event_type === "workflow-lifecycle-invoking").length, 1);
    assert.equal(lifecycleEvents.filter((event) => event.event_type === "workflow-lifecycle-submitted").length, 0);
    assert.equal(
      lifecycleEvents.filter((event) => event.event_type === "workflow-lifecycle-already-running").length,
      1
    );
    assert.deepEqual(disposalClosures, [
      { eventType: "workflow-lifecycle-already-running", journalPhase: "reconciled" }
    ]);
  }
);

type InitialWorkflowLinkCrashCut =
  "prepared-only" | "metadata-written" | "state-written" | "event-recorded" | "committed";

/**
 * The only cut still exercised as a real out-of-process crash. The child is killed
 * once the fake runner reports that the external invocation is in flight, so the
 * cut is observed through the runner's own hold marker and needs no filesystem
 * interception inside the child.
 */
type RealInitialStartCrashCut = "external-invoking";

async function killStartChildAtDurableCut(input: {
  project: string;
  runId: string;
  env: Record<string, string | undefined>;
  cut: RealInitialStartCrashCut;
}): Promise<void> {
  const childScript = path.join(input.project, `start-cut-${input.cut}.mjs`);
  const runtimeModuleUrl = pathToFileURL(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js")
  ).href;
  fs.writeFileSync(
    childScript,
    `const { startRun } = await import(${JSON.stringify(runtimeModuleUrl)});\n` +
      `await startRun(JSON.parse(process.env.UFZ_START_INPUT));\n`,
    "utf8"
  );
  const child = spawn(process.execPath, [childScript], {
    cwd: input.project,
    stdio: "ignore",
    env: {
      ...process.env,
      UFZ_START_INPUT: JSON.stringify({ projectRoot: input.project, runId: input.runId, env: input.env })
    }
  });
  const externalMarker = input.env.SMITHERS_START_HOLD_MARKER;
  const externalRelease = input.env.SMITHERS_START_HOLD_RELEASE;
  let cutObserved = false;
  try {
    await waitForPath(externalMarker!, 60_000);
    cutObserved = true;
  } finally {
    const exited =
      child.exitCode === null && child.signalCode === null
        ? new Promise<void>((resolve) => child.once("exit", () => resolve()))
        : Promise.resolve();
    // On the intended cut, preserve the crash-before-release ordering. If the
    // marker wait itself fails, release the detached fake runner first so the
    // failing test cannot strand a held child after its controller is killed.
    if (!cutObserved && externalRelease !== undefined) fs.writeFileSync(externalRelease, "release\n", "utf8");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    if (cutObserved && externalRelease !== undefined) fs.writeFileSync(externalRelease, "release\n", "utf8");
  }
  await waitForPath(input.env.SMITHERS_START_EXTERNAL_RUN!, 5_000);
}

test("startRun admits only an empty pre-intent run root and rejects traversal without writing", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const runId = "empty-preparation-root";
  const runRoot = path.join(project, ".ultrafuzz", "runs", runId);
  fs.mkdirSync(runRoot, { recursive: true });

  const recovered = await startRun({ projectRoot: project, runId, env });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));

  const userDirectory = path.join(project, "empty-user-directory");
  fs.mkdirSync(userDirectory);
  const traversed = await startRun({ projectRoot: project, runId: "../../empty-user-directory", env });
  assert.equal(traversed.ok, false);
  assert.equal(traversed.diagnostics[0]?.code, "unsafe-id");
  assert.deepEqual(fs.readdirSync(userDirectory), []);

  const occupiedRunId = "unowned-partial-root";
  const occupiedRoot = path.join(project, ".ultrafuzz", "runs", occupiedRunId);
  fs.mkdirSync(occupiedRoot, { recursive: true });
  const sentinel = path.join(occupiedRoot, "user-evidence.txt");
  fs.writeFileSync(sentinel, "preserve me\n", "utf8");
  const occupied = await startRun({ projectRoot: project, runId: occupiedRunId, env });
  assert.equal(occupied.ok, false);
  assert.equal(occupied.diagnostics[0]?.code, "START_PREPARATION_INVALID");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve me\n");

  const orphanedRunId = "orphaned-preparation-lock";
  const orphanedRoot = path.join(project, ".ultrafuzz", "runs", orphanedRunId);
  const orphanedLock = path.join(orphanedRoot, ".start-preparation-lock");
  fs.mkdirSync(orphanedLock, { recursive: true });
  fs.writeFileSync(
    path.join(orphanedLock, "owner.json"),
    `${JSON.stringify({ pid: 2_147_483_647, process_start: "dead", acquired_at: new Date().toISOString() })}\n`,
    "utf8"
  );
  const orphaned = await startRun({ projectRoot: project, runId: orphanedRunId, env });
  assert.equal(orphaned.ok, true, JSON.stringify(orphaned.diagnostics));

  const ownerlessRunId = "ownerless-preparation-lock";
  const ownerlessLock = path.join(project, ".ultrafuzz", "runs", ownerlessRunId, ".start-preparation-lock");
  fs.mkdirSync(ownerlessLock, { recursive: true });
  fs.utimesSync(ownerlessLock, new Date(0), new Date(0));
  const ownerless = await startRun({ projectRoot: project, runId: ownerlessRunId, env });
  assert.equal(ownerless.ok, true, JSON.stringify(ownerless.diagnostics));
});

test("startRun resumes exact missing layout, prompt, snapshot, and plan stages from its durable intent", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "prepared-stage-recovery";
  const env = fakeSmithersEnv(project);
  const startInput = {
    projectRoot: project,
    runId,
    env,
    prompt: "operator-secret-that-must-not-enter-the-intent",
    workflowInput: { token: "workflow-input-secret-that-must-not-enter-the-intent" }
  };
  const { planRun: preparePlanRun } = await import("../src/plan-run.js");
  const prepared = await preparePlanRun(startInput, { prepareWorkflowStart: true });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  const layout = prepared.value!.layout;
  const intentContents = fs.readFileSync(path.join(layout.root, "start-preparation-intent.json"), "utf8");
  assert.equal(intentContents.includes("operator-secret-that-must-not-enter-the-intent"), false);
  assert.equal(intentContents.includes("workflow-input-secret-that-must-not-enter-the-intent"), false);
  const promptPath = prepared.value!.rendered_prompts[0]!.rendered_prompt_path;
  const snapshotsRoot = path.join(layout.root, "prompt-snapshots");
  fs.rmSync(path.join(layout.root, "smithers", "start-preparation.json"));
  fs.rmSync(path.join(layout.root, "plan.json"));
  fs.rmSync(promptPath);
  fs.rmSync(snapshotsRoot, { recursive: true });
  fs.rmSync(layout.runMetadataPath);

  const recovered = await startRun(startInput);
  assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(layout.runMetadataPath, "utf8")) as {
    run_id?: string;
    workflow_ids?: string[];
  };
  assert.equal(metadata.run_id, runId);
  assert.deepEqual(metadata.workflow_ids, [`ultrafuzz-${runId}`]);
  assert.equal(fs.existsSync(promptPath), true);
  assert.equal(fs.existsSync(path.join(layout.root, "plan.json")), true);
  assert.equal(fs.existsSync(path.join(layout.root, "smithers", "start-preparation.json")), true);
});

test(
  "durable start preparation recovers and rejects conflicts at every intent, layout, reference, prompt, snapshot, plan, and preparation boundary",
  { concurrency: false },
  async () => {
    const { planRun: preparePlanRun } = await import("../src/plan-run.js");
    const layoutBoundaries = [
      "run metadata",
      "source metadata",
      "resolved config",
      "config redactions",
      "graph",
      "graph fingerprint",
      "state",
      "events",
      "usage ledger",
      "attempt ledger",
      "workspace manifest",
      "event query inputs"
    ] as const;

    for (const [boundaryIndex, boundary] of ["intent", ...layoutBoundaries].entries()) {
      const project = tempProject();
      initProject({ projectRoot: project, force: true });
      writeSmallTopology(project);
      const runId = `preparation-census-${boundaryIndex}`;
      const startInput = {
        projectRoot: project,
        runId,
        sourceRunId: "preparation-census-source",
        env: fakeSmithersEnv(project),
        prompt: "census operator prompt",
        workflowInput: { census: true }
      };
      const prepared = await preparePlanRun(startInput, { prepareWorkflowStart: true });
      assert.equal(prepared.ok, true, `${boundary}: ${JSON.stringify(prepared.diagnostics)}`);
      const layout = prepared.value!.layout;
      const intentPath = path.join(layout.root, "start-preparation-intent.json");
      const queryInputsPath = path.join(layout.eventsIndexDir, "query-inputs.json");
      const queryInputsBytes = fs.readFileSync(queryInputsPath);
      const orderedFiles = [
        layout.runMetadataPath,
        layout.sourceRunPath,
        layout.resolvedConfigPath,
        layout.configRedactionsPath,
        layout.graphPath,
        layout.graphFingerprintPath,
        layout.statePath,
        layout.eventsPath,
        layout.usageLedgerPath,
        layout.attemptLedgerPath,
        layout.workspacesPath,
        queryInputsPath
      ];
      const retained = new Set<string>([intentPath]);
      if (boundaryIndex > 0) {
        for (const filePath of orderedFiles.slice(0, boundaryIndex)) retained.add(filePath);
      }
      for (const entry of fs.readdirSync(layout.root)) {
        const candidate = path.join(layout.root, entry);
        if (candidate === intentPath) continue;
        if (
          boundaryIndex > 0 &&
          [
            layout.artifactsDir,
            layout.workspacesDir,
            layout.eventsIndexDir,
            layout.reviewDir,
            layout.pricingCatalogsDir
          ].includes(candidate)
        ) {
          for (const nested of fs.readdirSync(candidate)) fs.rmSync(path.join(candidate, nested), { recursive: true });
          continue;
        }
        if (!retained.has(candidate)) fs.rmSync(candidate, { recursive: true });
      }
      if (retained.has(queryInputsPath)) {
        // query-inputs was cleared with its directory; one exact file defines
        // the final layout-file cut.
        fs.mkdirSync(layout.eventsIndexDir, { recursive: true });
        fs.writeFileSync(queryInputsPath, queryInputsBytes);
      }

      const first = await preparePlanRun(startInput, { prepareWorkflowStart: true });
      assert.equal(first.ok, true, `${boundary}: ${JSON.stringify(first.diagnostics)}`);
      const afterFirst = exactFileTree(layout.root);
      const second = await preparePlanRun(startInput, { prepareWorkflowStart: true });
      assert.equal(second.ok, true, `${boundary}: ${JSON.stringify(second.diagnostics)}`);
      assert.deepEqual(exactFileTree(layout.root), afterFirst, `${boundary}: retry changed exact preparation bytes`);

      const conflictTarget = boundary === "intent" ? intentPath : orderedFiles[boundaryIndex - 1]!;
      if (boundary !== "intent") fs.rmSync(path.join(layout.root, "smithers", "start-preparation.json"));
      const hostile = Buffer.from(`conflicting-${boundary}\n`, "utf8");
      fs.writeFileSync(conflictTarget, hostile);
      const conflicted = await preparePlanRun(startInput, { prepareWorkflowStart: true });
      assert.equal(conflicted.ok, false, `${boundary}: conflicting bytes were admitted`);
      assert.equal(fs.readFileSync(conflictTarget).equals(hostile), true, `${boundary}: conflict was overwritten`);
    }

    for (const stage of ["prompt", "snapshot", "plan", "preparation"] as const) {
      const project = tempProject();
      initProject({ projectRoot: project, force: true });
      writeSmallTopology(project);
      const runId = `planning-census-${stage}`;
      const startInput = { projectRoot: project, runId, env: fakeSmithersEnv(project) };
      const prepared = await preparePlanRun(startInput, { prepareWorkflowStart: true });
      assert.equal(prepared.ok, true, `${stage}: ${JSON.stringify(prepared.diagnostics)}`);
      const layout = prepared.value!.layout;
      const preparationPath = path.join(layout.root, "smithers", "start-preparation.json");
      const planPath = path.join(layout.root, "plan.json");
      const persistedPlan = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
        rendered_prompts: Array<{ rendered_prompt_path: string; rendered_prompt_snapshot_path: string }>;
      };
      const promptPath = persistedPlan.rendered_prompts[0]!.rendered_prompt_path;
      const snapshotPath = path.join(layout.root, persistedPlan.rendered_prompts[0]!.rendered_prompt_snapshot_path);
      if (stage === "prompt") fs.rmSync(path.join(layout.root, "prompt-snapshots"), { recursive: true });
      if (stage === "prompt" || stage === "snapshot") fs.rmSync(planPath);
      if (stage !== "preparation") fs.rmSync(preparationPath);

      const first = await preparePlanRun(startInput, { prepareWorkflowStart: true });
      assert.equal(first.ok, true, `${stage}: ${JSON.stringify(first.diagnostics)}`);
      const afterFirst = exactFileTree(layout.root);
      const second = await preparePlanRun(startInput, { prepareWorkflowStart: true });
      assert.equal(second.ok, true, `${stage}: ${JSON.stringify(second.diagnostics)}`);
      assert.deepEqual(exactFileTree(layout.root), afterFirst, `${stage}: retry changed exact preparation bytes`);

      const conflictTarget =
        stage === "prompt"
          ? promptPath
          : stage === "snapshot"
            ? snapshotPath
            : stage === "plan"
              ? planPath
              : preparationPath;
      if (stage !== "preparation") fs.rmSync(preparationPath);
      const hostile = Buffer.from(`conflicting-${stage}\n`, "utf8");
      fs.writeFileSync(conflictTarget, hostile);
      const conflicted = await preparePlanRun(startInput, { prepareWorkflowStart: true });
      assert.equal(conflicted.ok, false, `${stage}: conflicting bytes were admitted`);
      assert.equal(fs.readFileSync(conflictTarget).equals(hostile), true, `${stage}: conflict was overwritten`);
    }

    const referenceProject = tempProject();
    initProject({ projectRoot: referenceProject, force: true });
    writeReferenceTopology(referenceProject);
    const xdgCacheHome = path.join(referenceProject, "xdg-cache");
    writeReferenceCache(xdgCacheHome);
    const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = xdgCacheHome;
    try {
      for (const stage of ["reference artifact", "reference event"] as const) {
        const runId = `reference-census-${stage.replace(" ", "-")}`;
        const startInput = { projectRoot: referenceProject, runId, env: fakeSmithersEnv(referenceProject) };
        const prepared = await preparePlanRun(startInput, { prepareWorkflowStart: true });
        assert.equal(prepared.ok, true, `${stage}: ${JSON.stringify(prepared.diagnostics)}`);
        const plan = prepared.value!;
        const layout = plan.layout;
        const metadata = JSON.parse(fs.readFileSync(layout.runMetadataPath, "utf8")) as { created_at: string };
        const initialState = createInitialRunState({
          runId,
          graphFingerprint: plan.graph_fingerprint,
          configFingerprint: plan.config_fingerprint,
          createdAt: metadata.created_at,
          workflowDeadlineSeconds: plan.resolved_config.run.workflowDeadlineSeconds,
          controllerLeaseSeconds: plan.resolved_config.run.controllerLeaseSeconds,
          requestedConcurrency: plan.resolved_config.run.maxParallelAgents,
          nodes: plan.state_nodes
        });
        const preparationPath = path.join(layout.root, "smithers", "start-preparation.json");
        fs.rmSync(preparationPath);
        fs.rmSync(path.join(layout.root, "plan.json"));
        fs.rmSync(path.join(layout.root, "prompt-snapshots"), { recursive: true });
        for (const prompt of plan.rendered_prompts) fs.rmSync(prompt.rendered_prompt_path);
        if (stage === "reference artifact") {
          writeRunState(layout, initialState);
          fs.writeFileSync(layout.eventsPath, "", "utf8");
          const queryBytes = fs.readFileSync(path.join(layout.eventsIndexDir, "query-inputs.json"));
          fs.rmSync(layout.eventsIndexDir, { recursive: true });
          fs.mkdirSync(layout.eventsIndexDir);
          fs.writeFileSync(path.join(layout.eventsIndexDir, "query-inputs.json"), queryBytes);
        }
        const referenceArtifact = path.join(
          layout.artifactsDir,
          "reference-properties-example",
          "references",
          "example.md"
        );
        assert.equal(fs.existsSync(referenceArtifact), true, stage);

        const first = await preparePlanRun(startInput, { prepareWorkflowStart: true });
        assert.equal(first.ok, true, `${stage}: ${JSON.stringify(first.diagnostics)}`);
        const afterFirst = exactFileTree(layout.root);
        const second = await preparePlanRun(startInput, { prepareWorkflowStart: true });
        assert.equal(second.ok, true, `${stage}: ${JSON.stringify(second.diagnostics)}`);
        assert.deepEqual(exactFileTree(layout.root), afterFirst, `${stage}: retry changed exact preparation bytes`);

        fs.rmSync(preparationPath);
        const conflictTarget = stage === "reference artifact" ? referenceArtifact : layout.eventsPath;
        if (stage === "reference artifact") fs.writeFileSync(conflictTarget, "conflicting-reference\n", "utf8");
        else fs.appendFileSync(conflictTarget, '{"conflicting":"reference-event"}\n', "utf8");
        const beforeConflict = fs.readFileSync(conflictTarget);
        const conflicted = await preparePlanRun(startInput, { prepareWorkflowStart: true });
        assert.equal(conflicted.ok, false, `${stage}: conflicting bytes were admitted`);
        assert.equal(
          fs.readFileSync(conflictTarget).equals(beforeConflict),
          true,
          `${stage}: conflicting evidence was overwritten`
        );
      }
    } finally {
      if (previousXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousXdgCacheHome;
    }
  }
);

test(
  "start preparation resumes reference artifacts without duplicating deterministic state or events",
  { concurrency: false },
  async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeReferenceTopology(project);
    const xdgCacheHome = path.join(project, "xdg-cache");
    writeReferenceCache(xdgCacheHome);
    const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = xdgCacheHome;
    try {
      const runId = "reference-start-recovery";
      const env = fakeSmithersEnv(project);
      const { planRun: preparePlanRun } = await import("../src/plan-run.js");
      const prepared = await preparePlanRun({ projectRoot: project, runId, env }, { prepareWorkflowStart: true });
      assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
      const layout = prepared.value!.layout;
      const eventBytes = fs.readFileSync(layout.eventsPath);
      fs.rmSync(path.join(layout.root, "smithers", "start-preparation.json"));
      fs.rmSync(path.join(layout.artifactsDir, "reference-properties-example", "references", "example.md"));

      const recovered = await startRun({ projectRoot: project, runId, env });

      assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
      assert.equal(fs.readFileSync(layout.eventsPath).subarray(0, eventBytes.length).equals(eventBytes), true);
      const referenceEvents = fs
        .readFileSync(layout.eventsPath, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line.includes('"event_type":"reference-materialized"'));
      assert.equal(referenceEvents.length, 1);
    } finally {
      if (previousXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousXdgCacheHome;
    }
  }
);

test("startRun retries are idempotent after the initial workflow link commits", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "idempotent-prepared-start";
  const env = fakeSmithersEnv(project);

  const first = await startRun({ projectRoot: project, runId, env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  const commandsBefore = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  const mutationLock = path.join(first.value!.run_root, ".workflow-mutation");
  fs.mkdirSync(mutationLock);
  fs.writeFileSync(
    path.join(mutationLock, "owner.json"),
    `${JSON.stringify({ pid: 2_147_483_647, process_start: "dead", acquired_at: new Date().toISOString() })}\n`,
    "utf8"
  );
  const second = await startRun({ projectRoot: project, runId, env });
  const third = await startRun({ projectRoot: project, runId, env });

  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  assert.equal(third.ok, true, JSON.stringify(third.diagnostics));
  assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), commandsBefore);
  const layout = layoutForRunRoot(first.value!.run_root);
  const journal = JSON.parse(fs.readFileSync(workflowRunLinkJournalPath(layout), "utf8")) as {
    entries?: unknown[];
  };
  assert.equal(journal.entries?.length, 1);
  assert.equal(workflowLinkEventCount(layout, verifyCommittedWorkflowRunLink(layout).link_id), 1);
});

test("lifecycle action lock reclaims SIGKILL owners and PID-reuse tokens", { concurrency: false }, async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const run = await startRun({ projectRoot: project, runId: "lifecycle-lock-reclaim", env: fakeSmithersEnv(project) });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  const marker = path.join(project, "lifecycle-lock-held");
  const childScript = path.join(project, "hold-lifecycle-lock.mjs");
  const mutationModuleUrl = pathToFileURL(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "workflow-mutation.js")
  ).href;
  fs.writeFileSync(
    childScript,
    `import fs from "node:fs";\n` +
      `import { layoutForRunRoot } from ${JSON.stringify(testArtifactsModuleUrl)};\n` +
      `import { acquireWorkflowLifecycleActionLock } from ${JSON.stringify(mutationModuleUrl)};\n` +
      `const layout = layoutForRunRoot(${JSON.stringify(layout.root)}, ${JSON.stringify(layout.runId)});\n` +
      `await acquireWorkflowLifecycleActionLock(layout);\n` +
      `fs.writeFileSync(${JSON.stringify(marker)}, "held\\n");\n` +
      `setInterval(() => {}, 1000);\n`,
    "utf8"
  );
  const child = spawn(process.execPath, [childScript], { cwd: project, stdio: "ignore" });
  await waitForPath(marker, 10_000);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const releaseAfterKill = await acquireWorkflowLifecycleActionLock(layout);
  await releaseAfterKill();
  const lockPath = path.join(layout.root, ".workflow-lifecycle-action");
  assert.equal(fs.existsSync(lockPath), false);

  fs.mkdirSync(lockPath);
  fs.writeFileSync(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      process_start: "different-process-generation",
      acquired_at: new Date().toISOString()
    })}\n`,
    "utf8"
  );
  const releaseAfterPidReuse = await acquireWorkflowLifecycleActionLock(layout);
  await releaseAfterPidReuse();
  assert.equal(fs.existsSync(lockPath), false);
});

test("startRun rejects non-exact invocation-attempt journal bytes without invoking or overwriting", async () => {
  for (const mutation of ["unexpected-field", "noncanonical-snapshot-root", "nested-snapshot-root"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `invalid-start-attempt-${mutation}`;
    const env = fakeSmithersEnv(project);
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, `${mutation}: ${JSON.stringify(run.diagnostics)}`);
    const journalPath = startSubmissionJournalPath(layoutForRunRoot(run.value!.run_root));
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      invocation_attempts: Array<Record<string, unknown>>;
    };
    const attempt = journal.invocation_attempts[0]!;
    if (mutation === "unexpected-field") {
      attempt.injected = true;
    } else if (mutation === "noncanonical-snapshot-root") {
      const snapshotRoot = attempt.execution_snapshot_root as string;
      attempt.execution_snapshot_root = `${path.dirname(snapshotRoot)}${path.sep}..${path.sep}execution-snapshots${path.sep}${path.basename(snapshotRoot)}`;
    } else {
      attempt.execution_snapshot_root = path.join(attempt.execution_snapshot_root as string, "nested");
    }
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    const journalBefore = fs.readFileSync(journalPath);
    const commandsBefore = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");

    const rejected = await startRun({ projectRoot: project, runId, env });

    assert.equal(rejected.ok, false, mutation);
    assert.equal(fs.readFileSync(journalPath).equals(journalBefore), true, mutation);
    assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), commandsBefore, mutation);
  }
});

test("linked workflow evidence rejects non-exact initial submission commands and events without overwriting", async () => {
  for (const mutation of ["command", "submitting-event", "submitted-event"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `invalid-start-evidence-${mutation}`;
    const env = fakeSmithersEnv(project);
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, `${mutation}: ${JSON.stringify(run.diagnostics)}`);
    const layout = layoutForRunRoot(run.value!.run_root);
    const targetPath =
      mutation === "command" ? path.join(layout.root, "smithers", "submission.json") : layout.eventsPath;
    if (mutation === "command") {
      const submission = JSON.parse(fs.readFileSync(targetPath, "utf8")) as { command: string[] };
      submission.command[1] = "inspect";
      fs.writeFileSync(targetPath, `${JSON.stringify(submission, null, 2)}\n`, "utf8");
    } else {
      const eventType = mutation === "submitting-event" ? "workflow-submitting" : "workflow-submitted";
      const events = fs
        .readFileSync(targetPath, "utf8")
        .trimEnd()
        .split(/\r?\n/u)
        .map((line) => {
          const event = JSON.parse(line) as { event_type?: string; payload?: Record<string, unknown> };
          if (event.event_type === eventType) event.payload = { ...event.payload, injected: true };
          return JSON.stringify(event);
        });
      fs.writeFileSync(targetPath, `${events.join("\n")}\n`, "utf8");
    }
    const targetBefore = fs.readFileSync(targetPath);

    const rejected = await readLinkedWorkflowEvidence(project, runId);

    assert.equal(rejected.ok, false, mutation);
    assert.equal(fs.readFileSync(targetPath).equals(targetBefore), true, mutation);
  }
});

test("initial submission evidence requires the exact durably authorized command vector", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "exact-start-command";
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  const submissionPath = path.join(layout.root, "smithers", "submission.json");
  const journalPath = startSubmissionJournalPath(layout);
  const originalSubmission = fs.readFileSync(submissionPath, "utf8");
  const originalJournal = fs.readFileSync(journalPath, "utf8");
  const mutations: Array<{ name: string; mutate(command: string[]): void }> = [
    {
      name: "detach-omission",
      mutate(command) {
        command.splice(command.indexOf("--detach"), 1);
      }
    },
    {
      name: "flag-duplication",
      mutate(command) {
        command.splice(command.indexOf("--format"), 0, "--detach");
      }
    },
    {
      name: "flag-reordering",
      mutate(command) {
        const maxConcurrency = command.slice(6, 8);
        const root = command.slice(8, 10);
        command.splice(6, 4, ...root, ...maxConcurrency);
      }
    },
    {
      name: "concurrency-substitution",
      mutate(command) {
        command[command.indexOf("--max-concurrency") + 1] = "9";
      }
    },
    {
      name: "root-substitution",
      mutate(command) {
        command[command.indexOf("--root") + 1] = path.join(project, "other-root");
      }
    },
    {
      name: "log-directory-substitution",
      mutate(command) {
        command[command.indexOf("--log-dir") + 1] = path.join(layout.root, "smithers", "other-logs");
      }
    },
    {
      name: "format-substitution",
      mutate(command) {
        command[command.indexOf("--format") + 1] = "jsonl";
      }
    },
    {
      name: "supervisor-substitution",
      mutate(command) {
        command[command.indexOf("--supervise-max-concurrent") + 1] = "2";
      }
    }
  ];

  for (const mutation of mutations) {
    const submission = JSON.parse(originalSubmission) as { command: string[] };
    mutation.mutate(submission.command);
    const submissionBytes = `${JSON.stringify(submission, null, 2)}\n`;
    const journal = JSON.parse(originalJournal) as { external_evidence_sha256?: string };
    journal.external_evidence_sha256 = sha256Stable(submissionBytes);
    const journalBytes = `${JSON.stringify(journal, null, 2)}\n`;
    fs.writeFileSync(submissionPath, submissionBytes, "utf8");
    fs.writeFileSync(journalPath, journalBytes, "utf8");

    const rejected = await readLinkedWorkflowEvidence(project, runId);

    assert.equal(rejected.ok, false, mutation.name);
    assert.match(
      rejected.diagnostics[0]?.message ?? "",
      /submission evidence does not match its durable invocation intent/u,
      mutation.name
    );
    assert.equal(fs.readFileSync(submissionPath, "utf8"), submissionBytes, mutation.name);
    assert.equal(fs.readFileSync(journalPath, "utf8"), journalBytes, mutation.name);
    fs.writeFileSync(submissionPath, originalSubmission, "utf8");
    fs.writeFileSync(journalPath, originalJournal, "utf8");
  }
});

test("prepared start binding rejects coordinated journal, evidence, and evidence-hash command mutation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "coordinated-start-command-mutation";
  const run = await startRun({ projectRoot: project, runId, maxConcurrency: 4, env: fakeSmithersEnv(project) });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  const submissionPath = path.join(layout.root, "smithers", "submission.json");
  const journalPath = startSubmissionJournalPath(layout);
  const submission = JSON.parse(fs.readFileSync(submissionPath, "utf8")) as { command: string[] };
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    invocation_attempts: Array<{ command: string[] }>;
    external_evidence_sha256: string;
  };
  submission.command[submission.command.indexOf("--max-concurrency") + 1] = "9";
  journal.invocation_attempts.at(-1)!.command = [...submission.command];
  const submissionBytes = `${JSON.stringify(submission, null, 2)}\n`;
  journal.external_evidence_sha256 = sha256Stable(submissionBytes);
  const journalBytes = `${JSON.stringify(journal, null, 2)}\n`;
  fs.writeFileSync(submissionPath, submissionBytes, "utf8");
  fs.writeFileSync(journalPath, journalBytes, "utf8");

  const rejected = await readLinkedWorkflowEvidence(project, runId);

  assert.equal(rejected.ok, false);
  assert.match(rejected.diagnostics[0]?.message ?? "", /invocation command is invalid/u);
  assert.equal(fs.readFileSync(submissionPath, "utf8"), submissionBytes);
  assert.equal(fs.readFileSync(journalPath, "utf8"), journalBytes);
});

test("startRun rejects a conflicting generated workflow without overwriting it", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "conflicting-prepared-workflow";
  const env = fakeSmithersEnv(project);
  const { planRun: preparePlanRun } = await import("../src/plan-run.js");
  const prepared = await preparePlanRun({ projectRoot: project, runId, env }, { prepareWorkflowStart: true });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  const workflowPath = path.join(project, ".smithers", "workflows", `ultrafuzz-${runId}.tsx`);
  const hostile = "export default function HostileWorkflow() {}\n";
  fs.writeFileSync(workflowPath, hostile, "utf8");

  const started = await startRun({ projectRoot: project, runId, env });

  assert.equal(started.ok, false);
  assert.equal(started.diagnostics[0]?.code, "WORKFLOW_COMPILE_FAILED");
  assert.equal(fs.readFileSync(workflowPath, "utf8"), hostile);
});

test("incomplete start recovery rejects conflicting metadata, state, events, and control bytes without overwriting", async () => {
  const cases: Array<{
    name: string;
    mutate(layout: ReturnType<typeof layoutForRunRoot>): string;
  }> = [
    {
      name: "forge guard metadata",
      mutate(layout) {
        const metadata = JSON.parse(fs.readFileSync(layout.runMetadataPath, "utf8")) as Record<string, unknown>;
        metadata.forge_guard = { active: true, injected: true };
        fs.writeFileSync(layout.runMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
        return layout.runMetadataPath;
      }
    },
    {
      name: "workflow state provenance",
      mutate(layout) {
        const state = JSON.parse(fs.readFileSync(layout.statePath, "utf8")) as RunState;
        state.provenance = { workflow: { runId: "injected-workflow" } };
        fs.writeFileSync(layout.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        return layout.statePath;
      }
    },
    {
      name: "injected event",
      mutate(layout) {
        fs.appendFileSync(
          layout.eventsPath,
          `${JSON.stringify({
            schema_version: "1.0",
            event_id: "evt-injected",
            timestamp: new Date().toISOString(),
            run_id: layout.runId,
            event_type: "workflow-link-recorded",
            payload: { workflow_run_id: "injected" }
          })}\n`,
          "utf8"
        );
        return layout.eventsPath;
      }
    },
    {
      name: "unexpected control file",
      mutate(layout) {
        const filePath = path.join(layout.root, "smithers", "workflow-run-link-journal.json");
        fs.writeFileSync(filePath, '{"injected":true}\n', "utf8");
        return filePath;
      }
    }
  ];

  for (const testCase of cases) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `conflicting-incomplete-${crypto.randomUUID()}`;
    const env = fakeSmithersEnv(project);
    const { planRun: preparePlanRun } = await import("../src/plan-run.js");
    const prepared = await preparePlanRun({ projectRoot: project, runId, env }, { prepareWorkflowStart: true });
    assert.equal(prepared.ok, true, `${testCase.name}: ${JSON.stringify(prepared.diagnostics)}`);
    const layout = prepared.value!.layout;
    fs.rmSync(path.join(layout.root, "smithers", "start-preparation.json"));
    const targetPath = testCase.mutate(layout);
    const before = fs.readFileSync(targetPath);

    const recovered = await startRun({ projectRoot: project, runId, env });

    assert.equal(recovered.ok, false, testCase.name);
    assert.equal(fs.readFileSync(targetPath).equals(before), true, testCase.name);
  }
});

test("startRun converges after dependency installation rejects before sealing or linking", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "install-rejection-recovery";
  const fakeBin = path.join(project, "failing-install-bin");
  fs.mkdirSync(fakeBin);
  const npmPath = path.join(fakeBin, "npm");
  fs.writeFileSync(npmPath, "#!/bin/sh\nprintf 'intentional install failure\\n' >&2\nexit 23\n", "utf8");
  fs.chmodSync(npmPath, 0o755);
  const smithersLog = path.join(project, "recovered-smithers.log");
  const failingEnv = {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_FAKE_LOG: smithersLog
  };

  await assert.rejects(
    () => startRun({ projectRoot: project, runId, env: failingEnv }),
    /intentional install failure/u
  );
  const runRoot = path.join(project, ".ultrafuzz", "runs", runId);
  assert.equal(fs.existsSync(path.join(runRoot, "start-preparation-intent.json")), true);
  assert.equal(fs.existsSync(path.join(runRoot, "smithers", "start-preparation.json")), true);
  assert.equal(fs.existsSync(workflowRunLinkJournalPath(layoutForRunRoot(runRoot))), false);

  writeFakeInstalledSmithers(project);
  const recovered = await startRun({ projectRoot: project, runId, env: failingEnv });

  assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
  assert.equal(verifyCommittedWorkflowRunLink(layoutForRunRoot(runRoot)).action, "start");
  assert.match(fs.readFileSync(smithersLog, "utf8"), /^up\b/mu);
});

test("a process cut during pre-link dependency installation retries from durable preparation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "process-cut-before-link";
  const fakeBin = path.join(project, "process-cut-bin");
  fs.mkdirSync(fakeBin);
  const installStarted = path.join(project, "install-started");
  const npmPath = path.join(fakeBin, "npm");
  fs.writeFileSync(
    npmPath,
    `#!/bin/sh\nprintf 'started\\n' > ${shellQuote(installStarted)}\nsleep 2\nexit 23\n`,
    "utf8"
  );
  fs.chmodSync(npmPath, 0o755);
  const childScript = path.join(project, "start-child.mjs");
  const runtimeModuleUrl = pathToFileURL(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js")
  ).href;
  fs.writeFileSync(
    childScript,
    `import { startRun } from ${JSON.stringify(runtimeModuleUrl)};\nawait startRun(JSON.parse(process.env.UFZ_START_INPUT));\n`,
    "utf8"
  );
  const childInput = {
    projectRoot: project,
    runId,
    env: {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: path.join(project, "process-cut-smithers.log")
    }
  };
  const child = spawn(process.execPath, [childScript], {
    cwd: project,
    stdio: "ignore",
    env: { ...process.env, UFZ_START_INPUT: JSON.stringify(childInput) }
  });
  await waitForPath(installStarted, 10_000);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const runRoot = path.join(project, ".ultrafuzz", "runs", runId);
  assert.equal(fs.existsSync(path.join(runRoot, "start-preparation-intent.json")), true);
  assert.equal(fs.existsSync(path.join(runRoot, "smithers", "start-preparation.json")), true);
  assert.equal(fs.existsSync(path.join(runRoot, "smithers", "control-integrity.json")), false);
  assert.equal(fs.existsSync(workflowRunLinkJournalPath(layoutForRunRoot(runRoot))), false);

  writeFakeInstalledSmithers(project);
  const recovered = await startRun(childInput);

  assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
  assert.equal(verifyCommittedWorkflowRunLink(layoutForRunRoot(runRoot)).action, "start");
});

test("detached start inspection treats contradictory missing and run-identity evidence as unknown", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  const installed = writeFakeInstalledSmithers(project);
  const workflowRunId = "ultrafuzz-contradictory-inspect";
  const cases = [
    {
      name: "successful missing response with exact identity",
      exit: 0,
      json: {
        ok: true,
        error: { code: "RUN_NOT_FOUND" },
        data: { run: { id: workflowRunId }, runState: { runId: workflowRunId } }
      },
      expected: "unknown"
    },
    {
      name: "failed missing response with conflicting identity",
      exit: 4,
      json: {
        error: { code: "RUN_NOT_FOUND" },
        data: { run: { id: "different-run" }, runState: { runId: "different-run" } }
      },
      expected: "unknown"
    },
    {
      name: "failed missing response with nested run-state evidence",
      exit: 4,
      json: {
        error: { code: "RUN_NOT_FOUND" },
        result: { value: { run: { status: "running" } } }
      },
      expected: "unknown"
    },
    {
      name: "successful response with conflicting top-level and nested identities",
      exit: 0,
      json: {
        runId: "different-run",
        data: { run: { id: workflowRunId }, runState: { runId: workflowRunId } }
      },
      expected: "unknown"
    },
    {
      name: "failed structured missing response without identity",
      exit: 4,
      json: { error: { code: "RUN_NOT_FOUND" } },
      expected: "absent"
    }
  ] as const;
  for (const testCase of cases) {
    fs.writeFileSync(
      installed.target,
      `#!/bin/sh\nprintf '%s\\n' ${shellQuote(JSON.stringify(testCase.json))}\nexit ${testCase.exit}\n`,
      "utf8"
    );
    fs.chmodSync(installed.target, 0o755);
    const observed = await inspectSmithersRunExistence({
      smithersRunId: workflowRunId,
      projectRoot: project,
      env: { PATH: process.env.PATH }
    });
    assert.equal(observed.status, testCase.expected, testCase.name);
  }
});

test("ambiguous detached start recovery fails closed on unbound inspection and disposes only its retry snapshot", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "ambiguous-start-unbound-inspection";
  const env = durableStartSmithersEnv(project, { holdDuringUp: true });
  env.SMITHERS_START_INSPECT_MODE = "unknown";
  await killStartChildAtDurableCut({ project, runId, env, cut: "external-invoking" });
  const layout = layoutForRunRoot(path.join(project, ".ultrafuzz", "runs", runId), runId);
  const snapshotsRoot = path.join(layout.root, "smithers", "execution-snapshots");
  const handedSnapshotRoots = fs.readdirSync(snapshotsRoot).sort();
  assert.equal(handedSnapshotRoots.length, 1);

  const recovered = await startRun({ projectRoot: project, runId, env });

  assert.equal(recovered.ok, false);
  assert.equal(recovered.diagnostics[0]?.code, "WORKFLOW_SUBMISSION_RECONCILIATION_REQUIRED");
  assert.equal(fs.readFileSync(env.SMITHERS_START_UP_ATTEMPTS, "utf8").trim(), "up");
  assert.deepEqual(fs.readdirSync(snapshotsRoot).sort(), handedSnapshotRoots);
  const submission = JSON.parse(fs.readFileSync(startSubmissionJournalPath(layout), "utf8")) as { phase?: string };
  assert.equal(submission.phase, "invoking");
  const linked = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(linked.ok, false);
});

test("detached start recovery requires matching correlation even when the inspected run ID is exact", async () => {
  for (const mode of ["absent", "mismatched"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `ambiguous-start-correlation-${mode}`;
    const env = durableStartSmithersEnv(project, { holdDuringUp: true });
    await killStartChildAtDurableCut({ project, runId, env, cut: "external-invoking" });
    if (mode === "absent") {
      env.SMITHERS_START_INSPECT_MODE = "no-correlation";
    } else {
      fs.writeFileSync(
        env.SMITHERS_START_EXTERNAL_CORRELATION,
        "ultrafuzz-runtime\nwrong-workflow-link\nwrong-controller-generation\n",
        "utf8"
      );
    }
    const layout = layoutForRunRoot(path.join(project, ".ultrafuzz", "runs", runId), runId);
    const snapshotsRoot = path.join(layout.root, "smithers", "execution-snapshots");
    const handedSnapshotRoots = fs.readdirSync(snapshotsRoot).sort();

    const recovered = await startRun({ projectRoot: project, runId, env });

    assert.equal(recovered.ok, false, mode);
    assert.equal(recovered.diagnostics[0]?.code, "WORKFLOW_SUBMISSION_RECONCILIATION_REQUIRED", mode);
    assert.match(recovered.diagnostics[0]?.message ?? "", /detached invocation correlation/u, mode);
    assert.equal(fs.readFileSync(env.SMITHERS_START_EXTERNAL_RUN, "utf8").trim(), `ultrafuzz-${runId}`, mode);
    assert.equal(fs.readFileSync(env.SMITHERS_START_UP_ATTEMPTS, "utf8").trim(), "up", mode);
    assert.deepEqual(fs.readdirSync(snapshotsRoot).sort(), handedSnapshotRoots, mode);
    const submission = JSON.parse(fs.readFileSync(startSubmissionJournalPath(layout), "utf8")) as {
      phase?: string;
    };
    assert.equal(submission.phase, "invoking", mode);
    assert.equal((await readLinkedWorkflowEvidence(project, runId)).ok, false, mode);
  }
});

test("startRun reuses an exact pre-link control seal without resealing it", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sealed-before-link-recovery";
  const env = fakeSmithersEnv(project);
  const { planRun: preparePlanRun } = await import("../src/plan-run.js");
  const { compileSmithersWorkflow, smithersExecutionControlFiles } = await import("../src/smithers.js");
  const { sealWorkflowControlFiles, workflowControlPaths } = await import("../src/workflow-integrity.js");
  const prepared = await preparePlanRun({ projectRoot: project, runId, env }, { prepareWorkflowStart: true });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  const plan = prepared.value!;
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.resolved_config,
    graph: plan.expanded_graph,
    runLayout: plan.layout,
    workflowName: `ultrafuzz-${runId}`,
    renderedPrompts: plan.rendered_prompts
  });
  const boundGraph = structuredClone(plan.graph);
  const tasksByConcrete = new Map<string, string[]>();
  for (const task of compiled.tasks) {
    const taskIds = tasksByConcrete.get(task.concreteNodeId) ?? [];
    taskIds.push(task.smithersNodeId);
    tasksByConcrete.set(task.concreteNodeId, taskIds);
  }
  for (const node of boundGraph.nodes) {
    const taskIds = tasksByConcrete.get(node.id) ?? [];
    if (taskIds.length > 0) node.workflow = { node_id: taskIds[0], task_node_ids: taskIds };
  }
  fs.writeFileSync(plan.layout.graphPath, `${JSON.stringify(boundGraph, null, 2)}\n`, "utf8");
  const executionFiles = await smithersExecutionControlFiles(compiled, plan.layout, env);
  const paths = workflowControlPaths(project, plan.layout);
  sealWorkflowControlFiles({
    projectRoot: project,
    layout: plan.layout,
    workflowPath: compiled.workflowPath,
    expandedGraphPath: compiled.expandedGraphPath,
    configPath: compiled.configPath,
    evidenceWorkflowPath: compiled.evidenceWorkflowPath,
    tasksPath: compiled.tasksPath,
    inputPath: compiled.inputPath,
    executionFiles
  });
  const sealBefore = fs.readFileSync(paths.integrityPath);

  const recovered = await startRun({ projectRoot: project, runId, env });

  assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
  assert.equal(fs.readFileSync(paths.integrityPath).equals(sealBefore), true);
  assert.equal(verifyCommittedWorkflowRunLink(plan.layout).action, "start");
});

test("compile, install, and seal cut boundaries are exact, idempotent, and conflict-preserving", async () => {
  const { planRun: preparePlanRun } = await import("../src/plan-run.js");
  const { compileSmithersWorkflow, smithersExecutionControlFiles } = await import("../src/smithers.js");
  const { sealWorkflowControlFiles, workflowControlPaths } = await import("../src/workflow-integrity.js");
  for (const stage of ["compile", "install", "seal"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `control-boundary-${stage}`;
    const installer = writeFakeNpmInstaller(project);
    const env = {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    };
    const prepared = await preparePlanRun({ projectRoot: project, runId, env }, { prepareWorkflowStart: true });
    assert.equal(prepared.ok, true, `${stage}: ${JSON.stringify(prepared.diagnostics)}`);
    const plan = prepared.value!;
    const compiled = compileSmithersWorkflow({
      projectRoot: project,
      config: plan.resolved_config,
      graph: plan.expanded_graph,
      runLayout: plan.layout,
      workflowName: `ultrafuzz-${runId}`,
      renderedPrompts: plan.rendered_prompts
    });
    let executionFiles: Awaited<ReturnType<typeof smithersExecutionControlFiles>> | undefined;
    if (stage !== "compile") {
      const boundGraph = structuredClone(plan.graph);
      const tasksByConcrete = new Map<string, string[]>();
      for (const task of compiled.tasks) {
        const taskIds = tasksByConcrete.get(task.concreteNodeId) ?? [];
        taskIds.push(task.smithersNodeId);
        tasksByConcrete.set(task.concreteNodeId, taskIds);
      }
      for (const node of boundGraph.nodes) {
        const taskIds = tasksByConcrete.get(node.id) ?? [];
        if (taskIds.length > 0) node.workflow = { node_id: taskIds[0], task_node_ids: taskIds };
      }
      fs.writeFileSync(plan.layout.graphPath, `${JSON.stringify(boundGraph, null, 2)}\n`, "utf8");
      executionFiles = await smithersExecutionControlFiles(compiled, plan.layout, env);
    }
    if (stage === "seal") {
      sealWorkflowControlFiles({
        projectRoot: project,
        layout: plan.layout,
        workflowPath: compiled.workflowPath,
        expandedGraphPath: compiled.expandedGraphPath,
        configPath: compiled.configPath,
        evidenceWorkflowPath: compiled.evidenceWorkflowPath,
        tasksPath: compiled.tasksPath,
        inputPath: compiled.inputPath,
        executionFiles
      });
    }

    const conflictTarget =
      stage === "compile"
        ? path.join(plan.layout.root, "smithers", "execution-dependencies.json")
        : stage === "install"
          ? workflowControlPaths(project, plan.layout).integrityPath
          : workflowRunLinkJournalPath(plan.layout);
    const hostile = Buffer.from(`conflicting-${stage}-successor\n`, "utf8");
    fs.writeFileSync(conflictTarget, hostile);
    await assert.rejects(() => startRun({ projectRoot: project, runId, env }));
    assert.equal(fs.readFileSync(conflictTarget).equals(hostile), true, `${stage}: conflict was overwritten`);
    fs.rmSync(conflictTarget);

    const first = await startRun({ projectRoot: project, runId, env });
    assert.equal(first.ok, true, `${stage}: ${JSON.stringify(first.diagnostics)}`);
    const afterFirst = exactFileTree(plan.layout.root);
    const second = await startRun({ projectRoot: project, runId, env });
    assert.equal(second.ok, true, `${stage}: ${JSON.stringify(second.diagnostics)}`);
    assert.deepEqual(exactFileTree(plan.layout.root), afterFirst, `${stage}: retry changed durable run bytes`);
    assert.equal(
      fs
        .readFileSync(installer.smithersLogPath, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("up ")).length,
      1,
      stage
    );
  }
});

test("workflow dependency sealing maps required root and package peers while omitting explicitly optional peers", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const installed = writeFakeInstalledSmithers(project);
  const rootManifestPath = path.join(project, ".smithers", "package.json");
  const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, "utf8")) as Record<string, unknown>;
  rootManifest.peerDependencies = { "root-required-peer": "1.0.0", "root-optional-peer": "1.0.0" };
  rootManifest.peerDependenciesMeta = { "root-optional-peer": { optional: true } };
  fs.writeFileSync(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`, "utf8");
  const runnerManifest = JSON.parse(fs.readFileSync(installed.packageJson, "utf8")) as Record<string, unknown>;
  runnerManifest.peerDependencies = { "runner-required-peer": "1.0.0", "runner-optional-peer": "1.0.0" };
  runnerManifest.peerDependenciesMeta = { "runner-optional-peer": { optional: true } };
  fs.writeFileSync(installed.packageJson, `${JSON.stringify(runnerManifest, null, 2)}\n`, "utf8");
  for (const name of ["root-required-peer", "runner-required-peer"]) {
    const packageRoot = path.join(project, ".smithers", "node_modules", name);
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name, version: "1.0.0" })}\n`, "utf8");
    fs.writeFileSync(path.join(packageRoot, "index.js"), "export {};\n", "utf8");
  }
  const env = {
    PATH: process.env.PATH,
    SMITHERS_FAKE_LOG: path.join(project, "peer-smithers.log")
  };

  const started = await startRun({ projectRoot: project, runId: "required-peer-closure", env });

  assert.equal(started.ok, true, JSON.stringify(started.diagnostics));
  const dependencyMap = JSON.parse(
    fs.readFileSync(path.join(started.value!.run_root, "smithers", "execution-dependencies.json"), "utf8")
  ) as {
    packages: Array<{ id: string; name: string }>;
    issuers: Array<{ id: string; dependencies: Record<string, string> }>;
  };
  const targetByName = new Map(dependencyMap.packages.map((entry) => [entry.name, entry.id]));
  const rootIssuer = dependencyMap.issuers.find((entry) => entry.id === "root")!;
  const runnerId = targetByName.get("smithers-orchestrator")!;
  const runnerIssuer = dependencyMap.issuers.find((entry) => entry.id === runnerId)!;
  assert.equal(rootIssuer.dependencies["root-required-peer"], targetByName.get("root-required-peer"));
  assert.equal(runnerIssuer.dependencies["runner-required-peer"], targetByName.get("runner-required-peer"));
  assert.equal(rootIssuer.dependencies["root-optional-peer"], undefined);
  assert.equal(runnerIssuer.dependencies["runner-optional-peer"], undefined);
});

test("workflow dependency sealing rejects an unavailable required root peer", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  writeFakeInstalledSmithers(project);
  const manifestPath = path.join(project, ".smithers", "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.peerDependencies = { "missing-required-peer": "1.0.0" };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await assert.rejects(
    () =>
      startRun({
        projectRoot: project,
        runId: "missing-required-peer",
        env: { PATH: process.env.PATH, SMITHERS_FAKE_LOG: path.join(project, "missing-peer.log") }
      }),
    /workflow dependency is unavailable for snapshot: root -> missing-required-peer/u
  );
});

async function initialWorkflowLinkCrashFixture(cut: InitialWorkflowLinkCrashCut): Promise<{
  project: string;
  runId: string;
  layout: ReturnType<typeof layoutForRunRoot>;
  env: Record<string, string | undefined>;
  linkId: string;
  targetMetadata: Record<string, unknown>;
  targetState: RunState;
}> {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = `initial-link-${cut}-${crypto.randomUUID()}`;
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  const targetMetadata = JSON.parse(fs.readFileSync(layout.runMetadataPath, "utf8")) as Record<string, unknown>;
  const targetState = JSON.parse(fs.readFileSync(layout.statePath, "utf8")) as RunState;
  const pristineMetadata = structuredClone(targetMetadata);
  pristineMetadata.workflow_ids = [];
  delete pristineMetadata.workflow;
  delete pristineMetadata.smithers;
  delete pristineMetadata.smithers_inspection_ids;
  const pristineState = structuredClone(targetState);
  if (pristineState.provenance !== undefined) {
    const provenance = structuredClone(pristineState.provenance);
    delete provenance.workflow;
    if (Object.keys(provenance).length === 0) delete pristineState.provenance;
    else pristineState.provenance = provenance;
  }
  fs.writeFileSync(
    layout.runMetadataPath,
    `${JSON.stringify(cut === "prepared-only" ? pristineMetadata : targetMetadata, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    layout.statePath,
    `${JSON.stringify(cut === "prepared-only" || cut === "metadata-written" ? pristineState : targetState, null, 2)}\n`,
    "utf8"
  );

  const journalPath = workflowRunLinkJournalPath(layout);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<Record<string, unknown>>;
  };
  const initialLink = journal.entries[0];
  assert.ok(initialLink);
  const linkId = initialLink.link_id;
  assert.equal(typeof linkId, "string");
  if (cut !== "committed") delete initialLink.committed_at;
  if (cut === "event-recorded") {
    initialLink.phase = "event-recorded";
  } else if (cut !== "committed") {
    initialLink.phase = "prepared";
    delete initialLink.link_event_id;
    delete initialLink.link_event_at;
    const retainedEvents = fs
      .readFileSync(layout.eventsPath, "utf8")
      .split(/\r?\n/u)
      .filter((line) => {
        if (line.trim().length === 0) return false;
        const event = JSON.parse(line) as { event_type?: string; payload?: { workflow_link_id?: string } };
        return event.event_type !== "workflow-link-recorded" || event.payload?.workflow_link_id !== linkId;
      });
    fs.writeFileSync(layout.eventsPath, `${retainedEvents.join("\n")}\n`, "utf8");
  }
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  return { project, runId, layout, env, linkId: linkId as string, targetMetadata, targetState };
}

function workflowLinkEventCount(layout: ReturnType<typeof layoutForRunRoot>, linkId: string): number {
  return fs
    .readFileSync(layout.eventsPath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => {
      if (line.trim().length === 0) return false;
      const event = JSON.parse(line) as { event_type?: string; payload?: { workflow_link_id?: string } };
      return event.event_type === "workflow-link-recorded" && event.payload?.workflow_link_id === linkId;
    }).length;
}

test("initial workflow links reconcile every durable crash cut from sealed controls", async () => {
  for (const cut of ["prepared-only", "metadata-written", "state-written", "event-recorded", "committed"] as const) {
    const fixture = await initialWorkflowLinkCrashFixture(cut);

    const first = await readLinkedWorkflowEvidence(fixture.project, fixture.runId, { reconcilePendingLink: true });
    const second = await readLinkedWorkflowEvidence(fixture.project, fixture.runId, { reconcilePendingLink: true });

    assert.equal(first.ok, true, "diagnostics" in first ? JSON.stringify(first.diagnostics) : undefined);
    assert.equal(second.ok, true, "diagnostics" in second ? JSON.stringify(second.diagnostics) : undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.layout.runMetadataPath, "utf8")), fixture.targetMetadata);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.layout.statePath, "utf8")), fixture.targetState);
    assert.equal(workflowLinkEventCount(fixture.layout, fixture.linkId), 1);
    assert.equal(verifyCommittedWorkflowRunLink(fixture.layout).link_id, fixture.linkId);
  }
});

test("startRun retries reconcile every pending initial-link cut without resubmission", async () => {
  for (const cut of ["prepared-only", "metadata-written", "state-written", "event-recorded", "committed"] as const) {
    const fixture = await initialWorkflowLinkCrashFixture(cut);
    fs.writeFileSync(fixture.env.SMITHERS_FAKE_LOG!, "", "utf8");

    const first = await startRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
    const second = await startRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });

    assert.equal(first.ok, true, `${cut}: ${JSON.stringify(first.diagnostics)}`);
    assert.equal(second.ok, true, `${cut}: ${JSON.stringify(second.diagnostics)}`);
    assert.equal(fs.readFileSync(fixture.env.SMITHERS_FAKE_LOG!, "utf8"), "", cut);
    assert.equal(workflowLinkEventCount(fixture.layout, fixture.linkId), 1, cut);
    assert.equal(verifyCommittedWorkflowRunLink(fixture.layout).link_id, fixture.linkId, cut);
  }
});

test("initial workflow link reconciliation rejects conflicting partial bindings without overwriting them", async () => {
  const cases: Array<{
    name: string;
    cut: InitialWorkflowLinkCrashCut;
    mutate(fixture: Awaited<ReturnType<typeof initialWorkflowLinkCrashFixture>>): void;
  }> = [
    {
      name: "prepared journal",
      cut: "prepared-only",
      mutate: ({ layout }) => {
        const journalPath = workflowRunLinkJournalPath(layout);
        const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
          entries: Array<Record<string, unknown>>;
        };
        journal.entries[0]!.control_generation = "conflicting-generation";
        fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
      }
    },
    {
      name: "workflow ID",
      cut: "metadata-written",
      mutate: ({ layout }) => {
        const metadata = JSON.parse(fs.readFileSync(layout.runMetadataPath, "utf8")) as Record<string, unknown>;
        (metadata.workflow as Record<string, unknown>).run_id = "conflicting-workflow-run";
        fs.writeFileSync(layout.runMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      }
    },
    {
      name: "control generation",
      cut: "metadata-written",
      mutate: ({ layout }) => {
        const metadata = JSON.parse(fs.readFileSync(layout.runMetadataPath, "utf8")) as Record<string, unknown>;
        (metadata.workflow as Record<string, unknown>).control_generation = "conflicting-generation";
        fs.writeFileSync(layout.runMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      }
    },
    {
      name: "workflow path",
      cut: "metadata-written",
      mutate: ({ layout }) => {
        const metadata = JSON.parse(fs.readFileSync(layout.runMetadataPath, "utf8")) as Record<string, unknown>;
        (metadata.workflow as Record<string, unknown>).path = "../conflicting-workflow.tsx";
        fs.writeFileSync(layout.runMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      }
    },
    {
      name: "state provenance",
      cut: "state-written",
      mutate: ({ layout }) => {
        const state = JSON.parse(fs.readFileSync(layout.statePath, "utf8")) as RunState;
        const workflow = state.provenance?.workflow as Record<string, unknown>;
        workflow.runId = "conflicting-workflow-run";
        fs.writeFileSync(layout.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      }
    },
    {
      name: "link event",
      cut: "event-recorded",
      mutate: ({ layout, linkId }) => {
        const events = fs
          .readFileSync(layout.eventsPath, "utf8")
          .trimEnd()
          .split(/\r?\n/u)
          .map((line) => {
            const event = JSON.parse(line) as { event_type?: string; payload?: Record<string, unknown> };
            if (event.event_type === "workflow-link-recorded" && event.payload?.workflow_link_id === linkId) {
              event.payload.workflow_run_id = "conflicting-workflow-run";
            }
            return JSON.stringify(event);
          });
        fs.writeFileSync(layout.eventsPath, `${events.join("\n")}\n`, "utf8");
      }
    },
    {
      name: "committed journal",
      cut: "committed",
      mutate: ({ layout }) => {
        const journalPath = workflowRunLinkJournalPath(layout);
        const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
          entries: Array<Record<string, unknown>>;
        };
        journal.entries[0]!.workflow_run_id = "conflicting-workflow-run";
        fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
      }
    }
  ];

  for (const testCase of cases) {
    const fixture = await initialWorkflowLinkCrashFixture(testCase.cut);
    testCase.mutate(fixture);
    const metadataBefore = fs.readFileSync(fixture.layout.runMetadataPath, "utf8");
    const stateBefore = fs.readFileSync(fixture.layout.statePath, "utf8");
    const treeBefore = exactFileTree(fixture.layout.root);

    const reconciled = await readLinkedWorkflowEvidence(fixture.project, fixture.runId, {
      reconcilePendingLink: true
    });

    assert.equal(reconciled.ok, false, testCase.name);
    assert.equal(fs.readFileSync(fixture.layout.runMetadataPath, "utf8"), metadataBefore, testCase.name);
    assert.equal(fs.readFileSync(fixture.layout.statePath, "utf8"), stateBefore, testCase.name);
    assert.deepEqual(exactFileTree(fixture.layout.root), treeBefore, testCase.name);
  }
});

test("a prepared replay cut is retired before a later resume", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "journal-prepared-replay-resume";
  const sourceWorkflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: sourceWorkflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "running", attempt: 1 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  const replayEntry = prepareWorkflowLifecycleAction(layout, {
    action: "replay",
    sourceWorkflowRunId,
    sourceWorkflowLinkId: verifyCommittedWorkflowRunLink(layout).link_id,
    controlGeneration: workflowControlGeneration(project, layout),
    knownWorkflowRunIds: [sourceWorkflowRunId]
  });
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({ projectRoot: project, runId, env });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.workflow_run_id, sourceWorkflowRunId);
  assert.equal(resumed.value?.submitted, false);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, new RegExp(`^inspect ${sourceWorkflowRunId} --format json$`, "mu"));
  assert.doesNotMatch(commands, /^(?:fork|replay|up)\b/mu);
  const journal = JSON.parse(fs.readFileSync(workflowLifecycleActionJournalPath(layout), "utf8")) as {
    entries?: Array<{ action_id?: string; phase?: string }>;
  };
  assert.equal(journal.entries?.find((candidate) => candidate.action_id === replayEntry.action_id)?.phase, "failed");
  assert.throws(
    () =>
      transitionWorkflowLifecycleAction(layout, replayEntry.action_id, "invoking", {
        controller_invocation_id: "controller-after-terminal",
        controller_invoked_at: new Date().toISOString()
      }),
    /cannot transition from failed to invoking/u
  );
});

test("a prepared replay cut with an invoking event closes, disposes its snapshot, and remains retryable", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "journal-prepared-replay-invoking-cut";
  const sourceWorkflowRunId = `ultrafuzz-${runId}`;
  const childWorkflowRunId = `${sourceWorkflowRunId}-child`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({ workflowRunId: sourceWorkflowRunId, steps: [] }),
    timeline: {
      data: { timeline: { runId: sourceWorkflowRunId, frames: [{ frameNo: 7, forks: [] }], children: [] } }
    },
    replayRunId: childWorkflowRunId
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  const baselineSnapshots = workflowExecutionSnapshotCount(layout.root);
  const sourceLink = verifyCommittedWorkflowRunLink(layout);
  const controlSnapshot = verifyWorkflowControlSnapshot(project, layout);
  const preparedSnapshot = materializeWorkflowExecutionSnapshot({
    projectRoot: project,
    layout,
    snapshot: controlSnapshot
  });
  const entry = prepareWorkflowLifecycleAction(layout, {
    action: "replay",
    sourceWorkflowRunId,
    sourceWorkflowLinkId: sourceLink.link_id,
    controlGeneration: controlSnapshot.generation,
    knownWorkflowRunIds: [sourceWorkflowRunId],
    forkFrame: 7
  });
  const invoking = appendEvent(layout, {
    eventType: "workflow-lifecycle-invoking",
    status: "running",
    payload: {
      action: "replay",
      workflow_run_id: sourceWorkflowRunId,
      control_generation: controlSnapshot.generation,
      workflow_link_id: sourceLink.link_id,
      lifecycle_action_id: entry.action_id,
      execution_snapshot_root: preparedSnapshot.root
    }
  });
  assert.equal(workflowExecutionSnapshotCount(layout.root), baselineSnapshots + 1);
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const retried = await replayRun({ projectRoot: project, runId, forkFrame: 7, env });

  assert.equal(retried.ok, true, JSON.stringify(retried.diagnostics));
  assert.equal(retried.value?.workflow_run_id, childWorkflowRunId);
  assert.equal(fs.existsSync(preparedSnapshot.root), false);
  assert.equal(workflowExecutionSnapshotCount(layout.root), baselineSnapshots + 1);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.equal(commands.match(/^replay\b/gmu)?.length, 1);
  assert.equal(commands.match(/^up\b/gmu)?.length, 1);
  const events = replayEvents(layout, Number.MAX_SAFE_INTEGER).records;
  const closure = events.find(
    (event) =>
      event.event_type === "workflow-lifecycle-failed" &&
      eventPayload(event.payload).controller_invocation_id === invoking.event_id
  );
  assert.ok(closure);
  assert.deepEqual(
    {
      action: eventPayload(closure.payload).action,
      workflow_run_id: eventPayload(closure.payload).workflow_run_id,
      control_generation: eventPayload(closure.payload).control_generation,
      workflow_link_id: eventPayload(closure.payload).workflow_link_id,
      lifecycle_action_id: eventPayload(closure.payload).lifecycle_action_id,
      controller_invocation_id: eventPayload(closure.payload).controller_invocation_id,
      controller_invoked_at: eventPayload(closure.payload).controller_invoked_at,
      failure_reason: eventPayload(closure.payload).failure_reason
    },
    {
      action: "replay",
      workflow_run_id: sourceWorkflowRunId,
      control_generation: controlSnapshot.generation,
      workflow_link_id: sourceLink.link_id,
      lifecycle_action_id: entry.action_id,
      controller_invocation_id: invoking.event_id,
      controller_invoked_at: invoking.timestamp,
      failure_reason: "prepared-lifecycle-action-never-invoked"
    }
  );
  const journal = JSON.parse(fs.readFileSync(workflowLifecycleActionJournalPath(layout), "utf8")) as {
    entries?: Array<{ action_id?: string; phase?: string }>;
  };
  assert.deepEqual(
    journal.entries?.map((candidate) => [candidate.action_id, candidate.phase]),
    [
      [entry.action_id, "failed"],
      [journal.entries?.[1]?.action_id, "reconciled"]
    ]
  );
  assert.notEqual(journal.entries?.[1]?.action_id, entry.action_id);
});

test("a torn workflow-link update is completed from its lifecycle journal without repeating replay", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "journal-torn-link";
  const sourceWorkflowRunId = `ultrafuzz-${runId}`;
  const childWorkflowRunId = `${sourceWorkflowRunId}-replayed-child`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({ workflowRunId: sourceWorkflowRunId, steps: [] })
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  const controlGeneration = workflowControlGeneration(project, layout);
  const actionEntry = prepareWorkflowLifecycleAction(layout, {
    action: "replay",
    sourceWorkflowRunId,
    sourceWorkflowLinkId: verifyCommittedWorkflowRunLink(layout).link_id,
    controlGeneration,
    knownWorkflowRunIds: [sourceWorkflowRunId],
    forkFrame: 7
  });
  const invoking = appendEvent(layout, {
    eventType: "workflow-lifecycle-invoking",
    status: "running",
    payload: {
      action: "replay",
      workflow_run_id: sourceWorkflowRunId,
      control_generation: controlGeneration,
      workflow_link_id: verifyCommittedWorkflowRunLink(layout).link_id,
      lifecycle_action_id: actionEntry.action_id
    }
  });
  transitionWorkflowLifecycleAction(layout, actionEntry.action_id, "invoking", {
    controller_invocation_id: invoking.event_id,
    controller_invoked_at: invoking.timestamp
  });
  transitionWorkflowLifecycleAction(layout, actionEntry.action_id, "external-result", {
    external_workflow_run_id: childWorkflowRunId,
    external_result_at: new Date().toISOString()
  });
  const workflowLink = prepareWorkflowRunLink(layout, {
    action: "replay",
    sourceWorkflowRunId,
    workflowRunId: childWorkflowRunId,
    controlGeneration,
    lifecycleActionId: actionEntry.action_id,
    controllerInvocationId: invoking.event_id,
    controllerInvokedAt: invoking.timestamp
  });

  const metadata = JSON.parse(fs.readFileSync(layout.runMetadataPath, "utf8")) as Record<string, unknown>;
  const workflow = metadata.workflow as Record<string, unknown>;
  fs.writeFileSync(
    layout.runMetadataPath,
    `${JSON.stringify(
      {
        ...metadata,
        workflow_ids: [childWorkflowRunId],
        workflow: {
          ...workflow,
          run_id: childWorkflowRunId,
          control_generation: controlGeneration,
          workflow_link_id: workflowLink.link_id
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(
    env.SMITHERS_FAKE_INSPECT!,
    `${JSON.stringify(workflowInspect({ workflowRunId: childWorkflowRunId, steps: [] }), null, 2)}\n`,
    "utf8"
  );
  const branchLabel = workflowLifecycleCorrelationLabel(actionEntry.action_id);
  fs.writeFileSync(
    env.SMITHERS_FAKE_TIMELINE!,
    `${JSON.stringify(
      {
        data: {
          timeline: {
            runId: sourceWorkflowRunId,
            frames: [{ frameNo: 7, forks: [{ runId: childWorkflowRunId, branchLabel }] }],
            children: [{ runId: childWorkflowRunId, branch: branchLabel, frames: [], children: [] }]
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const reconciled = await replayRun({ projectRoot: project, runId, forkFrame: 7, env });

  assert.equal(reconciled.ok, true, JSON.stringify(reconciled.diagnostics));
  assert.equal(reconciled.value?.workflow_run_id, childWorkflowRunId);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.doesNotMatch(commands, /^replay\b/mu);
  assert.match(commands, new RegExp(`^inspect ${childWorkflowRunId} --format json$`, "mu"));
  const state = JSON.parse(fs.readFileSync(layout.statePath, "utf8")) as {
    provenance?: { workflow?: { runId?: string; inspection?: { runId?: string }; linkId?: string } };
  };
  assert.equal(state.provenance?.workflow?.runId, childWorkflowRunId);
  assert.equal(state.provenance?.workflow?.inspection?.runId, childWorkflowRunId);
  assert.equal(state.provenance?.workflow?.linkId, workflowLink.link_id);
  const linkJournal = JSON.parse(fs.readFileSync(workflowRunLinkJournalPath(layout), "utf8")) as {
    entries?: Array<{ link_id?: string; phase?: string }>;
  };
  assert.equal(linkJournal.entries?.find((entry) => entry.link_id === workflowLink.link_id)?.phase, "committed");
  const actionJournal = JSON.parse(fs.readFileSync(workflowLifecycleActionJournalPath(layout), "utf8")) as {
    entries?: Array<{ action_id?: string; phase?: string; workflow_link_id?: string }>;
  };
  const durableAction = actionJournal.entries?.find((entry) => entry.action_id === actionEntry.action_id);
  assert.equal(durableAction?.phase, "reconciled");
  assert.equal(durableAction?.workflow_link_id, workflowLink.link_id);
});

test("an uncertain replay with no discoverable child remains fenced and is never repeated", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "journal-uncertain-replay";
  const sourceWorkflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({ workflowRunId: sourceWorkflowRunId, steps: [] }),
    timeline: { data: { timeline: { runId: sourceWorkflowRunId, frames: [], children: [] } } }
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const baselineSnapshots = workflowExecutionSnapshotCount(run.value!.run_root);
  const layout = layoutForRunRoot(run.value!.run_root);
  const entry = prepareWorkflowLifecycleAction(layout, {
    action: "replay",
    sourceWorkflowRunId,
    sourceWorkflowLinkId: verifyCommittedWorkflowRunLink(layout).link_id,
    controlGeneration: workflowControlGeneration(project, layout),
    knownWorkflowRunIds: [sourceWorkflowRunId],
    forkFrame: 7
  });
  const invoking = appendEvent(layout, {
    eventType: "workflow-lifecycle-invoking",
    status: "running",
    payload: {
      action: "replay",
      workflow_run_id: sourceWorkflowRunId,
      control_generation: workflowControlGeneration(project, layout),
      workflow_link_id: verifyCommittedWorkflowRunLink(layout).link_id,
      lifecycle_action_id: entry.action_id
    }
  });
  transitionWorkflowLifecycleAction(layout, entry.action_id, "invoking", {
    controller_invocation_id: invoking.event_id,
    controller_invoked_at: invoking.timestamp
  });
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const first = await replayRun({ projectRoot: project, runId, forkFrame: 7, env });
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots);
  const second = await replayRun({ projectRoot: project, runId, forkFrame: 7, env });
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots);

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.match(first.diagnostics[0]?.message ?? "", /will not be repeated/u);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.doesNotMatch(commands, /^replay\b/mu);
  assert.doesNotMatch(commands, /^up\b/mu);
  assert.equal(commands.match(/^timeline\b/gmu)?.length, 2);
  const journal = JSON.parse(fs.readFileSync(workflowLifecycleActionJournalPath(layout), "utf8")) as {
    entries?: Array<{ action_id?: string; phase?: string }>;
  };
  assert.equal(
    journal.entries?.find((candidate) => candidate.action_id === entry.action_id)?.phase,
    "reconciliation-pending"
  );
});

test("lifecycle crash reconciliation adopts only one exact correlated direct branch", async () => {
  const scenarios = [
    { name: "unrelated-only", correlatedRunIds: [] as string[], succeeds: false },
    { name: "correlated-and-unrelated", correlatedRunIds: ["correlated-child"], succeeds: true },
    {
      name: "ambiguous-correlated",
      correlatedRunIds: ["correlated-child-one", "correlated-child-two"],
      succeeds: false
    }
  ];

  for (const scenario of scenarios) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `journal-correlation-${scenario.name}`;
    const sourceWorkflowRunId = `ultrafuzz-${runId}`;
    const unrelatedRunId = `${sourceWorkflowRunId}-unrelated`;
    const nestedParentRunId = `${sourceWorkflowRunId}-nested-parent`;
    const nestedCorrelatedRunId = `${sourceWorkflowRunId}-nested-correlated`;
    const correlatedRunIds = scenario.correlatedRunIds.map((suffix) => `${sourceWorkflowRunId}-${suffix}`);
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({ workflowRunId: sourceWorkflowRunId, steps: [] }),
      timeline: { data: { timeline: { runId: sourceWorkflowRunId, frames: [], children: [] } } }
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const baselineSnapshots = workflowExecutionSnapshotCount(run.value!.run_root);
    const layout = layoutForRunRoot(run.value!.run_root);
    const entry = prepareWorkflowLifecycleAction(layout, {
      action: "fork",
      sourceWorkflowRunId,
      sourceWorkflowLinkId: verifyCommittedWorkflowRunLink(layout).link_id,
      controlGeneration: workflowControlGeneration(project, layout),
      knownWorkflowRunIds: [sourceWorkflowRunId],
      forkFrame: 7,
      label: "operator-label"
    });
    const invoking = appendEvent(layout, {
      eventType: "workflow-lifecycle-invoking",
      status: "running",
      payload: {
        action: "fork",
        workflow_run_id: sourceWorkflowRunId,
        control_generation: workflowControlGeneration(project, layout),
        workflow_link_id: verifyCommittedWorkflowRunLink(layout).link_id,
        lifecycle_action_id: entry.action_id
      }
    });
    transitionWorkflowLifecycleAction(layout, entry.action_id, "invoking", {
      controller_invocation_id: invoking.event_id,
      controller_invoked_at: invoking.timestamp
    });
    const correlationLabel = workflowLifecycleCorrelationLabel(entry.action_id, "operator-label");
    fs.writeFileSync(
      env.SMITHERS_FAKE_TIMELINE!,
      `${JSON.stringify(
        {
          data: {
            timeline: {
              runId: sourceWorkflowRunId,
              frames: [
                {
                  frameNo: 7,
                  forks: [
                    { runId: unrelatedRunId, branchLabel: "unrelated-label" },
                    ...correlatedRunIds.map((workflowRunId) => ({
                      runId: workflowRunId,
                      branchLabel: correlationLabel
                    }))
                  ]
                },
                {
                  frameNo: 8,
                  forks: [{ runId: `${sourceWorkflowRunId}-wrong-frame`, branchLabel: correlationLabel }]
                }
              ],
              children: [
                {
                  runId: nestedParentRunId,
                  branch: "unrelated-label",
                  frames: [
                    {
                      frameNo: 7,
                      forks: [{ runId: nestedCorrelatedRunId, branchLabel: correlationLabel }]
                    }
                  ],
                  children: [
                    {
                      runId: nestedCorrelatedRunId,
                      branch: correlationLabel,
                      frames: [],
                      children: []
                    }
                  ]
                }
              ]
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    if (scenario.succeeds) {
      fs.writeFileSync(
        env.SMITHERS_FAKE_INSPECT!,
        `${JSON.stringify(workflowInspect({ workflowRunId: correlatedRunIds[0]!, steps: [] }), null, 2)}\n`,
        "utf8"
      );
    }
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

    const reconciled = await forkRun({
      projectRoot: project,
      runId,
      forkFrame: 7,
      label: "operator-label",
      env
    });

    assert.equal(reconciled.ok, scenario.succeeds, JSON.stringify(reconciled.diagnostics));
    assert.equal(
      workflowExecutionSnapshotCount(run.value!.run_root),
      baselineSnapshots + (scenario.succeeds ? 1 : 0),
      scenario.name
    );
    const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
    assert.doesNotMatch(commands, /^fork\b/mu);
    assert.doesNotMatch(commands, /^cancel\b/mu);
    assert.equal(commands.includes(unrelatedRunId), false);
    assert.equal(commands.includes(nestedCorrelatedRunId), false);
    if (scenario.succeeds) {
      assert.equal(reconciled.value?.workflow_run_id, correlatedRunIds[0]);
      assert.match(commands, new RegExp(`^up .* --resume ${correlatedRunIds[0]} `, "mu"));
      assert.equal(verifyCommittedWorkflowRunLink(layout).workflow_run_id, correlatedRunIds[0]);
    } else {
      assert.doesNotMatch(commands, /^up\b/mu);
      const journal = JSON.parse(fs.readFileSync(workflowLifecycleActionJournalPath(layout), "utf8")) as {
        entries?: Array<{ action_id?: string; phase?: string }>;
      };
      assert.equal(
        journal.entries?.find((candidate) => candidate.action_id === entry.action_id)?.phase,
        "reconciliation-pending"
      );
    }
  }
});

test("lifecycle actions reject sealed control mutation and a symlinked action journal before invoking the runner", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "lifecycle-control-mutation", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.appendFileSync(path.join(run.value!.run_root, "smithers", "input.json"), "hostile mutation\n", "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  for (const operation of [
    () => resumeRun({ projectRoot: project, runId: "lifecycle-control-mutation", env }),
    () => replayRun({ projectRoot: project, runId: "lifecycle-control-mutation", forkFrame: 1, env }),
    () => forkRun({ projectRoot: project, runId: "lifecycle-control-mutation", forkFrame: 1, env }),
    () => pauseRun({ projectRoot: project, runId: "lifecycle-control-mutation", env }),
    () => cancelRun({ projectRoot: project, runId: "lifecycle-control-mutation", env })
  ]) {
    const result = await operation();
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
  }
  assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), "");

  const journalProject = tempProject();
  initProject({ projectRoot: journalProject, force: true });
  writeSmallTopology(journalProject);
  const journalEnv = fakeSmithersEnv(journalProject);
  const journalRun = await startRun({
    projectRoot: journalProject,
    runId: "lifecycle-journal-symlink",
    env: journalEnv
  });
  assert.equal(journalRun.ok, true, JSON.stringify(journalRun.diagnostics));
  const layout = layoutForRunRoot(journalRun.value!.run_root);
  const journalPath = workflowLifecycleActionJournalPath(layout);
  const outside = path.join(journalProject, "outside-journal.json");
  fs.writeFileSync(outside, '{"outside":true}\n', "utf8");
  fs.symlinkSync(outside, journalPath);
  fs.writeFileSync(journalEnv.SMITHERS_FAKE_LOG!, "", "utf8");

  const rejected = await replayRun({
    projectRoot: journalProject,
    runId: "lifecycle-journal-symlink",
    forkFrame: 1,
    env: journalEnv
  });

  assert.equal(rejected.ok, false);
  assert.match(rejected.diagnostics[0]?.message ?? "", /journal.*symlink/iu);
  assert.equal(fs.readFileSync(journalEnv.SMITHERS_FAKE_LOG!, "utf8"), "");
  assert.equal(fs.readFileSync(outside, "utf8"), '{"outside":true}\n');

  const linkProject = tempProject();
  initProject({ projectRoot: linkProject, force: true });
  writeSmallTopology(linkProject);
  const linkEnv = fakeSmithersEnv(linkProject);
  const linkRun = await startRun({ projectRoot: linkProject, runId: "workflow-link-journal-symlink", env: linkEnv });
  assert.equal(linkRun.ok, true, JSON.stringify(linkRun.diagnostics));
  const linkLayout = layoutForRunRoot(linkRun.value!.run_root);
  const linkJournalPath = workflowRunLinkJournalPath(linkLayout);
  const outsideLinkJournal = path.join(linkProject, "outside-link-journal.json");
  fs.copyFileSync(linkJournalPath, outsideLinkJournal);
  fs.unlinkSync(linkJournalPath);
  fs.symlinkSync(outsideLinkJournal, linkJournalPath);
  fs.writeFileSync(linkEnv.SMITHERS_FAKE_LOG!, "", "utf8");

  const linkRejected = await resumeRun({ projectRoot: linkProject, runId: linkLayout.runId, env: linkEnv });

  assert.equal(linkRejected.ok, false);
  assert.match(linkRejected.diagnostics[0]?.message ?? "", /workflow run link journal.*symlink/iu);
  assert.equal(fs.readFileSync(linkEnv.SMITHERS_FAKE_LOG!, "utf8"), "");
  assert.equal(fs.readFileSync(outsideLinkJournal, "utf8").includes("workflow-run-link-journal.v1"), true);
});

test("metadata-only workflow ID replacement cannot redirect lifecycle or synchronization commands", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "metadata-workflow-swap";
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root);
  const metadata = JSON.parse(fs.readFileSync(layout.runMetadataPath, "utf8")) as Record<string, unknown>;
  const workflow = metadata.workflow as Record<string, unknown>;
  const redirectedWorkflowRunId = "attacker-selected-workflow-run";
  fs.writeFileSync(
    layout.runMetadataPath,
    `${JSON.stringify(
      {
        ...metadata,
        workflow_ids: [redirectedWorkflowRunId],
        workflow: { ...workflow, run_id: redirectedWorkflowRunId }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  for (const operation of [
    () => resumeRun({ projectRoot: project, runId, env }),
    () => pauseRun({ projectRoot: project, runId, env }),
    () => cancelRun({ projectRoot: project, runId, env }),
    () => syncRun({ projectRoot: project, runId, env })
  ]) {
    const result = await operation();
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
  }
  assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), "");
});

test("pause and cancel fence stale workflow synchronization while their external requests are in flight", async () => {
  for (const action of ["pause", "cancel"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `${action}-sync-race`;
    const workflowRunId = `ultrafuzz-${runId}`;
    const started = path.join(project, `${action}-started`);
    const release = path.join(project, `${action}-release`);
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId,
        status: "running",
        state: "running",
        steps: [{ id: "node:project-discovery", state: "in-progress", attempt: 1 }]
      }),
      ...(action === "pause"
        ? { pauseStartedMarkerPath: started, pauseReleaseMarkerPath: release, pauseStatus: "paused" as const }
        : { cancelStartedMarkerPath: started, cancelReleaseMarkerPath: release, cancelStatus: "cancelled" as const })
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const lifecycle =
      action === "pause"
        ? pauseRun({ projectRoot: project, runId, env })
        : cancelRun({ projectRoot: project, runId, env });
    await waitForPath(started);
    let lifecycleResult: Awaited<typeof lifecycle> | undefined;

    const synchronized = await syncRun(
      { projectRoot: project, runId, env },
      {
        beforeCommit: async () => {
          fs.writeFileSync(release, "release\n", "utf8");
          lifecycleResult = await lifecycle;
          assert.equal(lifecycleResult.ok, true, JSON.stringify(lifecycleResult.diagnostics));
        }
      }
    );

    assert.equal(synchronized.ok, true, JSON.stringify(synchronized.diagnostics));
    assert.equal(synchronized.value?.synced_nodes, 0);
    assert.ok(synchronized.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CONTINUATION_CHANGED"));
    assert.ok(lifecycleResult);
    const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
      status?: string;
    };
    assert.equal(state.status, action === "pause" ? "paused" : "canceled");
    const events = fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8");
    assert.match(
      events,
      new RegExp(action === "pause" ? "workflow-lifecycle-already-paused" : "workflow-cancel-confirmed", "u")
    );
  }
});

test(
  "cancel disposes its execution snapshot only after durable lifecycle closure",
  { concurrency: false },
  async () => {
    for (const outcome of ["confirmed", "failed"] as const) {
      const project = tempProject();
      initProject({ projectRoot: project, force: true });
      writeSmallTopology(project);
      const runId = `cancel-snapshot-${outcome}`;
      const workflowRunId = `ultrafuzz-${runId}`;
      const env = fakeLifecycleSmithersEnv(project, {
        inspect: workflowInspect({ workflowRunId, status: "running", state: "running", steps: [] }),
        cancelStatus: "cancelled"
      });
      const run = await startRun({ projectRoot: project, runId, env });
      assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
      const layout = layoutForRunRoot(run.value!.run_root);
      if (outcome === "failed") {
        fs.writeFileSync(env.SMITHERS_BIN!, "#!/bin/sh\nprintf '%s\\n' 'cancel failed' >&2\nexit 9\n", "utf8");
        fs.chmodSync(env.SMITHERS_BIN!, 0o755);
      }
      const closureTypes: Array<string | undefined> = [];

      const cancelled = await observeWorkflowExecutionSnapshotDisposals(
        layout.root,
        () => cancelRun({ projectRoot: project, runId, env }),
        () => closureTypes.push(replayEvents(layout, Number.MAX_SAFE_INTEGER).records.at(-1)?.event_type)
      );

      assert.equal(cancelled.ok, outcome === "confirmed", JSON.stringify(cancelled.diagnostics));
      assert.deepEqual(
        closureTypes,
        [outcome === "confirmed" ? "workflow-cancel-confirmed" : "workflow-lifecycle-failed"],
        outcome
      );
    }
  }
);

test("resume rejects an overlapping lifecycle command and releases its durable action lock", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const lifecycleStarted = path.join(project, "lifecycle-command-started");
  const lifecycleRelease = path.join(project, "lifecycle-command-release");
  const workflowRunId = "ultrafuzz-serialized-lifecycle-run";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    }),
    lifecycleStartedMarkerPath: lifecycleStarted,
    lifecycleReleaseMarkerPath: lifecycleRelease
  });
  const run = await startRun({ projectRoot: project, runId: "serialized-lifecycle-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const firstResume = resumeRun({
    projectRoot: project,
    runId: "serialized-lifecycle-run",
    force: true,
    env
  });
  await waitForPath(lifecycleStarted);
  assert.equal(fs.existsSync(path.join(run.value!.run_root, ".workflow-lifecycle-action")), true);

  let overlapping;
  try {
    overlapping = await resumeRun({
      projectRoot: project,
      runId: "serialized-lifecycle-run",
      force: true,
      env
    });
  } finally {
    fs.writeFileSync(lifecycleRelease, "release\n", "utf8");
  }
  assert.equal(overlapping.ok, false);
  assert.equal(overlapping.diagnostics[0]?.code, "WORKFLOW_LIFECYCLE_FAILED");

  const first = await firstResume;
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.equal(fs.existsSync(path.join(run.value!.run_root, ".workflow-lifecycle-action")), false);
  const eventsAfterFirst = fs
    .readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event_type?: string });
  assert.equal(eventsAfterFirst.filter((event) => event.event_type === "workflow-lifecycle-invoking").length, 1);
  assert.equal(eventsAfterFirst.filter((event) => event.event_type === "workflow-lifecycle-submitted").length, 1);

  const retry = await resumeRun({ projectRoot: project, runId: "serialized-lifecycle-run", force: true, env });
  assert.equal(retry.ok, true, JSON.stringify(retry.diagnostics));
});

test("resume refuses to invoke Smithers when a persisted rendered prompt was modified", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "lifecycle-prompt-integrity", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const promptPath = path.join(run.value!.run_root, "artifacts", "project-discovery", "prompt.rendered.md");
  fs.appendFileSync(promptPath, "\nmodified\n", "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({ projectRoot: project, runId: run.value!.run_id, env });

  assert.equal(resumed.ok, false);
  assert.equal(resumed.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
  assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), "");
});

test(
  "resume keeps an already-running linked workflow attached without launching a duplicate",
  { concurrency: false },
  async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId: "ultrafuzz-active-lifecycle-run",
        status: "running",
        steps: [{ id: "node:project-discovery", state: "running", attempt: 1 }]
      })
    });
    const run = await startRun({ projectRoot: project, runId: "active-lifecycle-run", env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

    const layout = layoutForRunRoot(run.value!.run_root);
    const disposalClosures: Array<string | undefined> = [];
    const resumed = await observeWorkflowExecutionSnapshotDisposals(
      layout.root,
      () => resumeRun({ projectRoot: project, runId: "active-lifecycle-run", maxConcurrency: 8, env }),
      () => disposalClosures.push(replayEvents(layout, Number.MAX_SAFE_INTEGER).records.at(-1)?.event_type)
    );

    assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
    assert.equal(resumed.value?.workflow_run_id, "ultrafuzz-active-lifecycle-run");
    assert.equal(resumed.value?.submitted, false);
    const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
    assert.match(commands, /inspect ultrafuzz-active-lifecycle-run --format json/u);
    assert.doesNotMatch(commands, /^up /mu);
    assert.deepEqual(disposalClosures, ["workflow-lifecycle-already-running"]);

    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
    const forced = await resumeRun({
      projectRoot: project,
      runId: "active-lifecycle-run",
      maxConcurrency: 8,
      force: true,
      retryFailed: true,
      env
    });
    assert.equal(forced.ok, true, JSON.stringify(forced.diagnostics));
    assert.equal(forced.value?.submitted, true);
    const forcedCommands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
    assert.match(
      forcedCommands,
      /up .*ultrafuzz-active-lifecycle-run\.tsx --resume ultrafuzz-active-lifecycle-run --run-id ultrafuzz-active-lifecycle-run --force --detach --max-concurrency 8 --format json/u
    );
  }
);

test("resume retries one failed workflow task before continuing a terminal unfinished run", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-terminal-retry-run",
      status: "failed",
      state: "failed",
      steps: [
        { id: "node:project-discovery", state: "failed", attempt: 1 },
        { id: "node:strategy", state: "pending", attempt: 0 }
      ]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "terminal-retry-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({
    projectRoot: project,
    runId: "terminal-retry-run",
    maxConcurrency: 8,
    force: true,
    retryFailed: true,
    env
  });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /inspect ultrafuzz-terminal-retry-run --format json/u);
  assert.match(
    commands,
    /timetravel .*ultrafuzz-terminal-retry-run\.tsx --run-id ultrafuzz-terminal-retry-run --node-id node:project-discovery --iteration 0 --no-deps --force --format json/u
  );
  assert.match(
    commands,
    /up .*ultrafuzz-terminal-retry-run\.tsx --resume ultrafuzz-terminal-retry-run --run-id ultrafuzz-terminal-retry-run --force --detach --max-concurrency 8 --format json/u
  );
});

test("resume retries failed tasks reported inside a successful terminal workflow", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-terminal-row-retry-run",
      status: "finished",
      state: "succeeded",
      failedChildKeys: ["node:project-discovery::3", "node:strategy::2"],
      steps: [
        { id: "node:project-discovery", state: "failed", attempt: 1 },
        { id: "node:strategy", state: "failed", attempt: 1 }
      ]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "terminal-row-retry-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({
    projectRoot: project,
    runId: "terminal-row-retry-run",
    maxConcurrency: 8,
    force: true,
    retryFailed: true,
    env
  });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /inspect ultrafuzz-terminal-row-retry-run --format json/u);
  assert.match(
    commands,
    /timetravel .*ultrafuzz-terminal-row-retry-run\.tsx --run-id ultrafuzz-terminal-row-retry-run --node-id node:project-discovery --iteration 3 --no-deps --force --format json/u
  );
  assert.match(
    commands,
    /timetravel .*ultrafuzz-terminal-row-retry-run\.tsx --run-id ultrafuzz-terminal-row-retry-run --node-id node:strategy --iteration 2 --no-deps --force --format json/u
  );
  assert.match(
    commands,
    /up .*ultrafuzz-terminal-row-retry-run\.tsx --resume ultrafuzz-terminal-row-retry-run --run-id ultrafuzz-terminal-row-retry-run --force --detach --max-concurrency 8 --format json/u
  );
});

test("resume retries one failed workflow task before continuing a stale unfinished run", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-stale-retry-run",
      status: "stale",
      state: "stale",
      steps: [
        { id: "node:project-discovery", state: "failed", attempt: 1 },
        { id: "node:strategy", state: "pending", attempt: 0 }
      ]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "stale-retry-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const statePath = path.join(run.value!.run_root, "state.json");
  const expired = JSON.parse(fs.readFileSync(statePath, "utf8")) as RunState;
  expired.workflow_deadline_at = new Date(0).toISOString();
  fs.writeFileSync(statePath, `${JSON.stringify(expired, null, 2)}\n`, "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  const resumedAfter = Date.now();

  const resumed = await resumeRun({
    projectRoot: project,
    runId: "stale-retry-run",
    maxConcurrency: 8,
    force: true,
    retryFailed: true,
    env
  });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  const resumedState = JSON.parse(fs.readFileSync(statePath, "utf8")) as RunState;
  assert.ok(Date.parse(resumedState.workflow_deadline_at ?? "") > resumedAfter);
  assert.equal(resumedState.status, "running");
  assert.equal(resumedState.finished_at, undefined);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /inspect ultrafuzz-stale-retry-run --format json/u);
  assert.match(
    commands,
    /timetravel .*ultrafuzz-stale-retry-run\.tsx --run-id ultrafuzz-stale-retry-run --node-id node:project-discovery --iteration 0 --no-deps --force --format json/u
  );
  assert.match(
    commands,
    /up .*ultrafuzz-stale-retry-run\.tsx --resume ultrafuzz-stale-retry-run --run-id ultrafuzz-stale-retry-run --force --detach --max-concurrency 8 --format json/u
  );
});

test("resume rewinds a run-level render failure before continuing unfinished work", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-render-recovery-run",
      status: "failed",
      state: "failed",
      error: { code: "WORKFLOW_RENDER_FAILED", cause: { code: "ENOENT" } },
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 0 }]
    }),
    timeline: { timeline: { frames: [{ frameNo: 2 }, { frameNo: 4 }] } }
  });
  const run = await startRun({ projectRoot: project, runId: "render-recovery-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({
    projectRoot: project,
    runId: "render-recovery-run",
    maxConcurrency: 8,
    force: true,
    retryFailed: true,
    env
  });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /timeline ultrafuzz-render-recovery-run --json/u);
  assert.match(commands, /rewind ultrafuzz-render-recovery-run 4 --yes --json/u);
  assert.match(
    commands,
    /up .*ultrafuzz-render-recovery-run\.tsx --resume ultrafuzz-render-recovery-run --run-id ultrafuzz-render-recovery-run --force --detach --max-concurrency 8 --format json/u
  );
  assert.doesNotMatch(commands, /retry-task/u);
});

test("resume transfers an incompatible legacy workflow ID to a valid durable lineage", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = `legacy-${"x".repeat(56)}`;
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      error: { code: "WORKFLOW_RENDER_FAILED", cause: { code: "ENOENT" } },
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 0 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({
    projectRoot: project,
    runId,
    maxConcurrency: 8,
    force: true,
    retryFailed: true,
    env
  });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  assert.match(resumed.value?.workflow_run_id ?? "", /^ufz-recovery-[a-f0-9]{32}$/u);
  const replacementRunId = resumed.value!.workflow_run_id;
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, new RegExp(`inspect ${workflowRunId} --format json`, "u"));
  assert.match(commands, new RegExp(`up .* --detach --run-id ${replacementRunId}`, "u"));
  assert.doesNotMatch(commands, /timeline|rewind|retry-task/u);
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    workflow?: { run_id?: string };
  };
  assert.equal(metadata.workflow?.run_id, replacementRunId);
});

test("resume suppresses duplicate submissions for every active workflow run state", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-retrying-lifecycle-run",
      status: "running",
      state: "retrying",
      steps: [{ id: "node:project-discovery", state: "retrying", attempt: 2 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "retrying-lifecycle-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  for (const state of [
    "in-progress",
    "started",
    "queued",
    "retrying",
    "waiting-approval",
    "waiting-event",
    "waiting-timer"
  ]) {
    fs.writeFileSync(
      env.SMITHERS_FAKE_INSPECT!,
      `${JSON.stringify(
        workflowInspect({
          workflowRunId: "ultrafuzz-retrying-lifecycle-run",
          status: "running",
          state,
          steps: [{ id: "node:project-discovery", state, attempt: 2 }]
        })
      )}\n`,
      "utf8"
    );
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

    const resumed = await resumeRun({ projectRoot: project, runId: "retrying-lifecycle-run", env });

    assert.equal(resumed.ok, true, `${state}: ${JSON.stringify(resumed.diagnostics)}`);
    assert.equal(resumed.value?.submitted, false, `state ${state} must suppress duplicate resume`);
    const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
    assert.match(commands, /inspect ultrafuzz-retrying-lifecycle-run --format json/u);
    assert.doesNotMatch(commands, /^up /mu, `state ${state} must not launch a duplicate up --resume`);
  }
});

test("resume fails closed on contradictory top-level and nested workflow states", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "contradictory-resume-state";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nestedInspection = workflowInspect({
    workflowRunId,
    status: "running",
    state: "retrying",
    steps: [{ id: "node:project-discovery", state: "retrying", attempt: 2 }]
  }) as Record<string, unknown>;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: { ...nestedInspection, run: { status: "failed" } }
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const baselineSnapshots = workflowExecutionSnapshotCount(run.value!.run_root);
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({ projectRoot: project, runId, env });

  assert.equal(resumed.ok, false);
  assert.equal(resumed.diagnostics[0]?.code, "WORKFLOW_LIFECYCLE_FAILED");
  assert.match(resumed.diagnostics[0]?.message ?? "", /contradictory top-level and nested run states/u);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, new RegExp(`^inspect ${workflowRunId} --format json$`, "mu"));
  assert.doesNotMatch(commands, /^up\b/mu);
  assert.doesNotMatch(commands, /^timetravel\b/mu);
  assert.equal(workflowExecutionSnapshotCount(run.value!.run_root), baselineSnapshots);
});

test("resume launches a missing-run replacement only for failed structured absence evidence", async () => {
  const cases: Array<{
    name: string;
    inspect(workflowRunId: string): unknown;
    rawInspect?: string;
    replacementExpected: boolean;
  }> = [
    {
      name: "stray missing-run text",
      inspect: () => ({}),
      rawInspect: "RUN_NOT_FOUND\n",
      replacementExpected: false
    },
    {
      name: "structured missing plus exact present evidence",
      inspect: (workflowRunId) => ({
        error: { code: "RUN_NOT_FOUND" },
        data: { run: { id: workflowRunId, status: "running" }, runState: { runId: workflowRunId, state: "running" } }
      }),
      replacementExpected: false
    },
    {
      name: "failed exact structured absence",
      inspect: () => ({ error: { code: "RUN_NOT_FOUND" } }),
      replacementExpected: true
    }
  ];

  for (const testCase of cases) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = `resume-strict-absence-${crypto.randomUUID()}`;
    const workflowRunId = `ultrafuzz-${runId}`;
    const env = fakeLifecycleSmithersEnv(project, {
      inspect: testCase.inspect(workflowRunId),
      events: "",
      tokenEvents: "",
      inspectExitCode: 4
    });
    if (testCase.rawInspect !== undefined) {
      fs.writeFileSync(env.SMITHERS_FAKE_INSPECT!, testCase.rawInspect, "utf8");
    }
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, `${testCase.name}: ${JSON.stringify(run.diagnostics)}`);
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

    const resumed = await resumeRun({ projectRoot: project, runId, env });
    const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
    const upCommands = commands.split(/\r?\n/u).filter((line) => line.startsWith("up "));

    assert.equal(resumed.ok, testCase.replacementExpected, testCase.name);
    assert.equal(upCommands.length, testCase.replacementExpected ? 1 : 0, testCase.name);
    if (testCase.replacementExpected) {
      assert.doesNotMatch(upCommands[0] ?? "", /--resume/u, testCase.name);
      assert.match(upCommands[0] ?? "", new RegExp(`--run-id ${workflowRunId}(?:\\s|$)`, "u"), testCase.name);
    } else {
      assert.equal(resumed.diagnostics[0]?.code, "WORKFLOW_LIFECYCLE_FAILED", testCase.name);
      assert.match(
        resumed.diagnostics[0]?.message ?? "",
        /could not prove the linked run before resume/u,
        testCase.name
      );
    }
  }
});

test("resume re-submits a quota-waiting workflow after credentials change", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-quota-resume-run",
      status: "waiting-quota",
      state: "waiting-quota",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "quota-resume-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({ projectRoot: project, runId: "quota-resume-run", env });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /inspect ultrafuzz-quota-resume-run --format json/u);
  assert.match(commands, /^up .*--resume ultrafuzz-quota-resume-run/mu);
});

test("resume --reset-node does not repeat a committed reset after a failed continuation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-reset-lifecycle-run",
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "reset-lifecycle-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const markerPath = path.join(run.value!.run_root, "smithers", "reset-node-applied.json");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const detached = await resumeRun({
    projectRoot: project,
    runId: "reset-lifecycle-run",
    resetNode: "node:project-discovery",
    env: { ...env, SMITHERS_FAKE_FAIL_UP: "1" }
  });

  assert.equal(detached.ok, false);
  assert.equal(detached.diagnostics[0]?.code, "WORKFLOW_LIFECYCLE_FAILED");
  assert.match(detached.diagnostics[0]?.message ?? "", /without repeating the reset/u);
  assert.equal(fs.existsSync(markerPath), true, "reset marker must persist after a failed continuation");
  const failedCommands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(failedCommands, /^timetravel /mu);
  const lifecycleEvents = fs
    .readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          event_id?: string;
          timestamp?: string;
          event_type?: string;
          status?: string;
          payload?: Record<string, unknown>;
        }
    )
    .filter((event) => event.event_type?.startsWith("workflow-lifecycle-"));
  const invokingEvent = lifecycleEvents.filter((event) => event.event_type === "workflow-lifecycle-invoking").at(-1);
  const failedEvent = lifecycleEvents.filter((event) => event.event_type === "workflow-lifecycle-failed").at(-1);
  assert.ok(invokingEvent);
  assert.ok(failedEvent);
  assert.equal(failedEvent.status, "running");
  assert.equal(failedEvent.payload?.action, "resume");
  assert.equal(failedEvent.payload?.workflow_run_id, "ultrafuzz-reset-lifecycle-run");
  assert.equal(failedEvent.payload?.controller_invocation_id, invokingEvent.event_id);
  assert.equal(failedEvent.payload?.controller_invoked_at, invokingEvent.timestamp);
  assert.equal(failedEvent.payload?.run_status, "running");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const retried = await resumeRun({
    projectRoot: project,
    runId: "reset-lifecycle-run",
    resetNode: "node:project-discovery",
    env
  });

  assert.equal(retried.ok, true, JSON.stringify(retried.diagnostics));
  assert.equal(retried.value?.submitted, true);
  assert.equal(fs.existsSync(markerPath), false, "reset marker must clear after a successful continuation");
  const retriedCommands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.doesNotMatch(retriedCommands, /^timetravel /mu, "retry must not repeat the destructive reset");
  assert.match(
    retriedCommands,
    /up .*ultrafuzz-reset-lifecycle-run\.tsx --resume ultrafuzz-reset-lifecycle-run --run-id ultrafuzz-reset-lifecycle-run --force --detach( --max-concurrency \d+)? --format json/u
  );
});

test("startRun retries persisted initial workflow evidence only after deterministic run absence is proven", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  const localConfig = fs.readFileSync(configPath, "utf8");
  fs.writeFileSync(
    configPath,
    `${localConfig.replace('[execution]\nmode = "local"', '[execution]\nmode = "cloud"\nprovider = "modal"')}

[execution.providers.modal]
app = "ultrafuzz-test"
image = "ultrafuzz-test"
credential_env = ["UFZ_PROVIDER_ONE", "UFZ_PROVIDER_TWO"]
`,
    "utf8"
  );

  const binDir = path.join(project, "fake-bin");
  const smithers = path.join(binDir, "smithers");
  const logPath = path.join(project, "recovery-smithers.log");
  const cloudEnvironmentLog = path.join(project, "recovery-cloud-environment.log");
  const markerPath = path.join(project, "initial-submission-attempted");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"',
      'if [ -n "$SMITHERS_FAKE_CLOUD_ENV_LOG" ] && [ "$1" = "up" ]; then',
      '  printf \'%s|%s\\n\' "$UFZ_PROVIDER_ONE" "$UFZ_PROVIDER_TWO" >> "$SMITHERS_FAKE_CLOUD_ENV_LOG"',
      "fi",
      'if [ "$1" = "inspect" ]; then',
      '  printf \'%s\\n\' \'{"error":{"code":"RUN_NOT_FOUND"}}\'',
      "  exit 4",
      "fi",
      'if [ "$1" = "up" ] && [ ! -f "$SMITHERS_FAKE_MARKER" ]; then',
      '  : > "$SMITHERS_FAKE_MARKER"',
      "  exit 42",
      "fi",
      "printf '%s\\n' '{\"ok\":true}'",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  const env = createSmithersTestEnvironment(smithers, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_FAKE_LOG: logPath,
    SMITHERS_FAKE_CLOUD_ENV_LOG: cloudEnvironmentLog,
    UFZ_PROVIDER_ONE: "provider-one",
    UFZ_PROVIDER_TWO: "provider-two",
    SMITHERS_FAKE_MARKER: markerPath
  });

  const initial = await startRun({ projectRoot: project, runId: "missing-workflow-run", maxConcurrency: 8, env });
  assert.equal(initial.ok, false);
  fs.writeFileSync(cloudEnvironmentLog, "", "utf8");

  const retried = await startRun({
    projectRoot: project,
    runId: "missing-workflow-run",
    maxConcurrency: 8,
    env
  });
  assert.equal(retried.ok, true, JSON.stringify(retried.diagnostics));
  assert.deepEqual(retried.value?.workflow_ids, ["ultrafuzz-missing-workflow-run"]);

  const commands = fs.readFileSync(logPath, "utf8").split("\n");
  const upCommands = commands.filter((line) => line.startsWith("up "));
  assert.equal(upCommands.length, 2);
  assert.match(commands.find((line) => line.startsWith("inspect ")) ?? "", /--format json/u);
  assert.doesNotMatch(upCommands[1] ?? "", /--resume/u);
  assert.match(upCommands[1] ?? "", /--max-concurrency 8 --root /u);
  assert.match(upCommands[1] ?? "", /--log-dir .* --input /u);
  assert.equal(fs.readFileSync(cloudEnvironmentLog, "utf8"), "provider-one|provider-two\n");

  const runRoot = path.join(project, ".ultrafuzz", "runs", "missing-workflow-run");
  const submission = JSON.parse(fs.readFileSync(path.join(runRoot, "smithers", "submission.json"), "utf8")) as {
    command?: string[];
  };
  assert.equal(submission.command?.includes("<redacted>"), true);
  const journal = JSON.parse(fs.readFileSync(path.join(runRoot, "smithers", "start-submission.json"), "utf8")) as {
    phase?: string;
    invocation_attempts?: Array<{ execution_snapshot_root?: string }>;
  };
  assert.equal(journal.phase, "submitted");
  assert.equal(journal.invocation_attempts?.length, 2);
  assert.notEqual(
    journal.invocation_attempts?.[0]?.execution_snapshot_root,
    journal.invocation_attempts?.[1]?.execution_snapshot_root
  );
  const state = JSON.parse(fs.readFileSync(path.join(runRoot, "state.json"), "utf8")) as { status?: string };
  assert.equal(state.status, "running");
});

test(
  "compiled Smithers workflow passes a real non-executing graph smoke",
  { skip: realSmithersGraphUnavailable() },
  async () => {
    const project = tempProject();
    fs.writeFileSync(path.join(project, "source.txt"), "candidate A\n", "utf8");
    execFileSync("git", ["add", "source.txt"], { cwd: project });
    execFileSync("git", ["commit", "-m", "candidate A"], { cwd: project, stdio: "ignore" });
    execFileSync("git", ["branch", "-M", "main"], { cwd: project });
    const candidateA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(project, "source.txt"), "local main B\n", "utf8");
    execFileSync("git", ["commit", "-am", "local main B"], { cwd: project, stdio: "ignore" });
    const localMainB = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "--detach", candidateA], { cwd: project, stdio: "ignore" });
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    fs.symlinkSync(runtimeSmithersNodeModules(), path.join(project, ".smithers", "node_modules"), "dir");

    const plan = await planRun({ projectRoot: project, runId: "graph-smoke", env: {} });
    assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
    const { compileSmithersWorkflow } = await import("../src/smithers.js");
    const compiled = compileSmithersWorkflow({
      projectRoot: project,
      config: plan.value!.resolved_config,
      graph: plan.value!.expanded_graph,
      runLayout: plan.value!.layout,
      workflowName: "ultrafuzz-graph-smoke",
      renderedPrompts: plan.value!.rendered_prompts,
      operatorPrompt: "graph smoke"
    });
    assert.notEqual(candidateA, localMainB);
    assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: project, encoding: "utf8" }).trim(), localMainB);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim(), candidateA);
    assert.equal(
      compiled.tasks.every((task) => task.baseCommit === candidateA),
      true
    );
    const persistedTasks = JSON.parse(fs.readFileSync(compiled.tasksPath, "utf8")) as {
      tasks?: Array<{ baseCommit?: string }>;
    };
    assert.equal(
      persistedTasks.tasks?.every((task) => task.baseCommit === candidateA),
      true
    );

    const graphProcess = spawnSync(
      runtimeSmithersBinary(),
      [
        "graph",
        compiled.evidenceWorkflowPath,
        "--run-id",
        compiled.smithersRunId,
        "--root",
        project,
        "--input",
        fs.readFileSync(compiled.inputPath, "utf8"),
        "--compact",
        "--format",
        "json"
      ],
      {
        cwd: project,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
        env: { ...process.env, OPENAI_API_KEY: "test-openai-api-key" }
      }
    );
    if (graphProcess.status !== 0 || graphProcess.stdout.trim() === "") {
      throw (
        graphProcess.error ??
        new Error(
          [
            `smithers graph exited ${String(graphProcess.status)}`,
            graphProcess.stderr.trim(),
            graphProcess.stdout.trim()
          ]
            .filter(Boolean)
            .join("\n")
        )
      );
    }
    const graphJson = graphProcess.stdout;
    const graph = JSON.parse(graphJson) as {
      tasks?: Array<{ nodeId?: string; worktreeBaseBranch?: string }>;
    };
    assert.equal(graph.tasks?.[0]?.nodeId, "prepare:project-discovery");
    assert.equal(graph.tasks?.[0]?.worktreeBaseBranch, candidateA);
    assert.equal(
      graph.tasks?.some((task) => task.nodeId === "node:project-discovery"),
      true
    );
    assert.equal(
      graph.tasks?.some((task) => task.nodeId === "verify:project-discovery"),
      true
    );
  }
);

function realSmithersGraphUnavailable(): string | false {
  if (!fs.existsSync(runtimeSmithersBinary())) {
    return "runtime Smithers CLI is not installed";
  }
  if (!fs.existsSync(path.join(runtimeSmithersNodeModules(), "smithers-orchestrator"))) {
    return "runtime Smithers dependencies are not installed";
  }
  return false;
}

function runtimeSmithersNodeModules(): string {
  return path.join(workspaceRoot(), "packages", "runtime", "node_modules");
}

function runtimeSmithersBinary(): string {
  return path.join(runtimeSmithersNodeModules(), ".bin", process.platform === "win32" ? "smithers.cmd" : "smithers");
}

function workspaceRoot(): string {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
}
