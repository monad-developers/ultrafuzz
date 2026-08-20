import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  execFileSync,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns
} from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";

import {
  GOAL_PLAN_JSON_SCHEMA_ID,
  THREAT_MODEL_JSON_SCHEMA_ID,
  goalPlanJsonSchema,
  threatModelJsonSchema,
  type RunState
} from "@ultrafuzz/artifacts";
import { packagedTopology } from "@ultrafuzz/config";
import {
  CACHE_MANIFEST_FILE,
  RUN_REFERENCE_MANIFEST_FILE,
  loadReferenceCatalog,
  parseReferenceCatalog
} from "@ultrafuzz/references";

import {
  assertSmithersPackageManifest,
  assertSmithersResolutionCutoff,
  KIMI_CODE_VERSION,
  renderSmithersPackageJson,
  REQUIRED_SMITHERS_OVERRIDES,
  SMITHERS_DEPENDENCY_RESOLUTION_CUTOFF,
  SMITHERS_EFFECT_VERSION,
  SMITHERS_ORCHESTRATOR_BIN_PATH,
  SMITHERS_ORCHESTRATOR_VERSION,
  smithersDependencyInstallArgs
} from "../src/smithers-package.js";
import { isTransientNpmRegistryFailure } from "../src/npm-install-retry.js";

import {
  ARTIFACT_RECONCILIATION_CLOCK_SKEW_MS,
  ARTIFACT_RECONCILIATION_GRACE_MS,
  ARTIFACT_RECONCILIATION_MAX_ATTEMPTS,
  ARTIFACT_RECONCILIATION_RETRY_INTERVAL_MS,
  forkRun,
  getRunHealth,
  getRunStatus,
  initProject,
  listRuns,
  planRun,
  pauseRun,
  readLinkedWorkflowEvidence,
  replayRun,
  repairMissingRenderedPromptsForRun,
  resumeRun,
  startRun,
  syncRun,
  toPlannedGraph,
  validateProject
} from "../src/index.js";
import { projectArtifactSchemaDir, projectArtifactSchemaJson } from "../src/init.js";
import {
  shippedReferenceCatalog,
  writeShippedDocumentReferenceCaches,
  writeShippedVulnerabilityDatabaseCache
} from "./reference-fixtures.js";
import { runSmithersInspectionCommand } from "../src/smithers.js";
import { acquireWorkflowExecutionSnapshotAnchor } from "../src/workflow-execution-snapshot-capability.js";
import { materializeWorkflowExecutionSnapshot } from "../src/workflow-integrity.js";
import { linkedWorkflowExecutionEnvironment } from "../src/start-run.js";

const runningUnderBun = typeof process.versions.bun === "string";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-"));
}

test("init copies the exact packaged full topology", () => {
  const project = tempProject();
  const initialized = initProject({ projectRoot: project, force: true });
  assert.equal(initialized.ok, true, JSON.stringify(initialized.diagnostics));
  assert.deepEqual(
    fs.readFileSync(path.join(project, ".ultrafuzz", "topology.yml")),
    fs.readFileSync(packagedTopology("full").path)
  );
});

function firstSymlinkUnder(root: string): string | undefined {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) return candidate;
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
  return undefined;
}

function openDescriptorTargetsInside(root: string): string[] {
  if (process.platform === "win32" || !fs.existsSync("/proc/self/fd")) return [];
  const resolvedRoot = path.resolve(root);
  const targets: string[] = [];
  for (const name of fs.readdirSync("/proc/self/fd")) {
    try {
      const target = fs.realpathSync(path.join("/proc/self/fd", name));
      const relative = path.relative(resolvedRoot, target);
      if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`))) targets.push(target);
    } catch {
      // A descriptor can close between enumeration and resolution.
    }
  }
  return targets.sort();
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
    .replace('from "./toml"', 'from "./toml.mjs"')
    .replace('from "./environment"', 'from "./environment.mjs"');
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
    preflight(options?: { rootDir?: string }): Promise<void>;
    buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
      command: string;
      args: string[];
      env?: Record<string, string>;
      stdin?: string;
      cleanup?: () => Promise<void>;
    }>;
  };
  createCodexAgent(options?: Record<string, unknown>): unknown;
  workflowControlChildEnvironment(
    additions?: Record<string, string | undefined>,
    source?: Record<string, string | undefined>
  ): Record<string, string>;
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
    .replace('from "./toml"', 'from "./toml.mjs"')
    .replace('from "./environment"', 'from "./environment.mjs"');
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
      preflight(options?: { rootDir?: string }): Promise<void>;
      buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
        command: string;
        args: string[];
        env?: Record<string, string>;
        stdin?: string;
        cleanup?: () => Promise<void>;
      }>;
    };
    createCodexAgent(options?: Record<string, unknown>): unknown;
  };
  const environmentModule = (await import(pathToFileURL(path.join(fixture, "environment.mjs")).href)) as {
    workflowControlChildEnvironment(
      additions?: Record<string, string | undefined>,
      source?: Record<string, string | undefined>
    ): Record<string, string>;
  };
  return {
    CompatibleCodexAgent: codexModule.CompatibleCodexAgent,
    createCodexAgent: codexModule.createCodexAgent,
    workflowControlChildEnvironment: environmentModule.workflowControlChildEnvironment
  };
}

async function loadGeneratedPiAgent(project: string): Promise<{
  createPiAgent(options?: Record<string, unknown>): {
    opts: { env: Record<string, string>; sessionDir?: string; apiKey?: string };
    buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
      command: string;
      args: string[];
      env?: Record<string, string>;
      outputFormat?: string;
    }>;
  };
}> {
  const fixture = path.join(project, "pi-agent-executable-test");
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
  const piSource = fs
    .readFileSync(path.join(agentsDir, "pi.ts"), "utf8")
    .replace('from "smithers-orchestrator"', `from ${JSON.stringify(smithersUrl)}`)
    .replace('from "./toml"', 'from "./toml.mjs"')
    .replace('from "./environment"', 'from "./environment.mjs"');
  fs.writeFileSync(path.join(fixture, "pi.mjs"), transpile(piSource), "utf8");
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
  const piModule = (await import(pathToFileURL(path.join(fixture, "pi.mjs")).href)) as {
    createPiAgent(options?: Record<string, unknown>): {
      opts: { env: Record<string, string>; sessionDir?: string; apiKey?: string };
      buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
        command: string;
        args: string[];
        env?: Record<string, string>;
        outputFormat?: string;
      }>;
    };
  };
  return { createPiAgent: piModule.createPiAgent };
}

type GeneratedOpenCodeCommand = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

type GeneratedOpenCodeAgent = {
  opts: { env: Record<string, string>; extraArgs?: string[]; variant?: string; yolo?: boolean };
  buildCommand(params: {
    prompt: string;
    cwd: string;
    options: Record<string, unknown>;
  }): Promise<GeneratedOpenCodeCommand>;
};

async function loadGeneratedOpenCodeAgent(project: string): Promise<{
  createOpenCodeAgent(options?: Record<string, unknown>): GeneratedOpenCodeAgent;
}> {
  const fixture = path.join(project, "opencode-agent-executable-test");
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
  const openCodeSource = fs
    .readFileSync(path.join(agentsDir, "opencode.ts"), "utf8")
    .replace('from "smithers-orchestrator"', `from ${JSON.stringify(smithersUrl)}`)
    .replace('from "./toml"', 'from "./toml.mjs"')
    .replace('from "./environment"', 'from "./environment.mjs"');
  fs.writeFileSync(path.join(fixture, "opencode.mjs"), transpile(openCodeSource), "utf8");
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
  return (await import(pathToFileURL(path.join(fixture, "opencode.mjs")).href)) as {
    createOpenCodeAgent(options?: Record<string, unknown>): GeneratedOpenCodeAgent;
  };
}

async function loadGeneratedDeepSeekAgent(project: string): Promise<{
  DeepSeekClaudeCodeAgent: new (options: Record<string, unknown>) => {
    generate(options: Record<string, unknown>): Promise<{ usage?: Record<string, unknown> }>;
    stream(options: Record<string, unknown>): Promise<{
      usage?: Promise<Record<string, unknown>>;
      totalUsage?: Promise<Record<string, unknown>>;
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
    .replace('from "./toml"', 'from "./toml.mjs"')
    .replace('from "./environment"', 'from "./environment.mjs"');
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
    DeepSeekClaudeCodeAgent: new (options: Record<string, unknown>) => {
      generate(options: Record<string, unknown>): Promise<{ usage?: Record<string, unknown> }>;
      stream(options: Record<string, unknown>): Promise<{
        usage?: Promise<Record<string, unknown>>;
        totalUsage?: Promise<Record<string, unknown>>;
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
  return { DeepSeekClaudeCodeAgent: deepSeekModule.DeepSeekClaudeCodeAgent };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
    '#!/bin/sh\nif [ -n "$SMITHERS_FAKE_EXECUTED_AS_LOG" ]; then printf \'%s\\n\' "$0" > "$SMITHERS_FAKE_EXECUTED_AS_LOG"; fi\nif [ -n "$SMITHERS_FAKE_PATH_LOG" ]; then printf \'%s\\n\' "$PATH" > "$SMITHERS_FAKE_PATH_LOG"; fi\nprintf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"\nprintf \'%s\\n\' \'{"ok":true}\'\n',
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

// `failures` makes the fake npm exit non-zero for its first N invocations, so a test
// can drive the install retry loop. The npm log doubles as the attempt counter.
function writeFakeNpmInstaller(
  project: string,
  failures: { count: number; stderr: readonly string[] } = { count: 0, stderr: [] }
): {
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
      ...(failures.count > 0
        ? [
            `if [ "$(wc -l < ${shellQuote(npmLogPath)})" -le ${failures.count} ]; then`,
            ...failures.stderr.map((line) => `  printf '%s\\n' ${shellQuote(line)} >&2`),
            "  exit 1",
            "fi"
          ]
        : []),
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

function fakeSmithersEnv(project: string): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'if [ -n "$SMITHERS_FAKE_LOG" ]; then',
      '  printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_SNAPSHOT_BYTES_LOG" ] && [ -n "$SMITHERS_FAKE_SNAPSHOT_ATTEMPT" ]; then',
      '  case "$2" in',
      "    */.smithers/workflows/*.tsx)",
      '      snapshot_workflow="$2"',
      '      snapshot_root="${snapshot_workflow%/.smithers/workflows/*}"',
      '      snapshot_prompt="$snapshot_root/controls/rendered-prompts/$SMITHERS_FAKE_SNAPSHOT_ATTEMPT.md"',
      '      snapshot_agent="$snapshot_root/.smithers/agents/codex.ts"',
      "      {",
      '        printf \'workflow=%s\\nconfig=%s\\nprompt=%s\\nagent=%s\\n\' "$snapshot_workflow" "$ULTRAFUZZ_CONFIG_PATH" "$snapshot_prompt" "$snapshot_agent"',
      '        cat "$snapshot_workflow" "$ULTRAFUZZ_CONFIG_PATH" "$snapshot_prompt" "$snapshot_agent"',
      '      } > "$SMITHERS_FAKE_SNAPSHOT_BYTES_LOG"',
      "      ;;",
      "  esac",
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
      "  fork)",
      "    printf '%s\\n' '{\"forkedRunId\":\"ultrafuzz-lifecycle-run-forked\"}'",
      "    ;;",
      "  replay)",
      "    printf '%s\\n' '{\"forkedRunId\":\"ultrafuzz-lifecycle-run-replayed\"}'",
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
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: smithers,
    SMITHERS_FAKE_LOG: path.join(project, "smithers-commands.log")
  };
}

function fakeLifecycleSmithersEnv(
  project: string,
  input: { inspect: unknown; events?: string; tokenEvents?: string; inspectMarkerPath?: string; timeline?: unknown }
): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const inspectPath = path.join(project, "fake-smithers-inspect.json");
  const eventsPath = path.join(project, "fake-smithers-events.ndjson");
  const tokenEventsPath =
    input.tokenEvents === undefined ? eventsPath : path.join(project, "fake-smithers-token-events.ndjson");
  const timelinePath = path.join(project, "fake-smithers-timeline.json");
  fs.writeFileSync(inspectPath, `${JSON.stringify(input.inspect, null, 2)}\n`, "utf8");
  fs.writeFileSync(eventsPath, input.events ?? "", "utf8");
  if (input.tokenEvents !== undefined) fs.writeFileSync(tokenEventsPath, input.tokenEvents, "utf8");
  fs.writeFileSync(
    timelinePath,
    `${JSON.stringify(input.timeline ?? { timeline: { frames: [] } }, null, 2)}\n`,
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
      'case "$1" in',
      "  inspect)",
      ...(input.inspectMarkerPath === undefined ? [] : [`    touch ${shellQuote(input.inspectMarkerPath)}`]),
      '    cat "$SMITHERS_FAKE_INSPECT"',
      "    ;;",
      "  cancel)",
      "    printf '%s\\n' '{\"status\":\"cancel-requested\"}'",
      "    exit 2",
      "    ;;",
      "  events)",
      '    if [ "$3" = "--type" ] && [ "$4" = "token" ]; then',
      '      cat "$SMITHERS_FAKE_TOKEN_EVENTS"',
      "    else",
      '      cat "$SMITHERS_FAKE_EVENTS"',
      "    fi",
      "    ;;",
      "  timeline)",
      '    cat "$SMITHERS_FAKE_TIMELINE"',
      "    ;;",
      "  rewind)",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "  fork)",
      '    if [ -n "$SMITHERS_FAKE_FORKED_RUN_ID" ]; then',
      '      printf \'{"forkedRunId":"%s"}\\n\' "$SMITHERS_FAKE_FORKED_RUN_ID"',
      "    else",
      "      printf '%s\\n' '{\"ok\":true}'",
      "    fi",
      "    ;;",
      "  up)",
      '    if [ -n "$SMITHERS_FAKE_FAIL_UP" ]; then',
      "      printf '%s\\n' 'fake up failure' >&2",
      "      exit 1",
      "    fi",
      '    if [ -n "$SMITHERS_FAKE_RUN_EXISTS" ]; then',
      '      case "$*" in',
      "        *--resume*) ;;",
      "        *)",
      '          printf \'%s\\n\' \'{"ok":false,"error":{"code":"RUN_EXISTS"}}\' >&2',
      "          exit 4",
      "          ;;",
      "      esac",
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
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: smithers,
    SMITHERS_FAKE_LOG: path.join(project, "smithers-commands.log"),
    SMITHERS_FAKE_INSPECT: inspectPath,
    SMITHERS_FAKE_EVENTS: eventsPath,
    SMITHERS_FAKE_TOKEN_EVENTS: tokenEventsPath,
    SMITHERS_FAKE_TIMELINE: timelinePath,
    ULTRAFUZZ_PRICING_CATALOG_URL: "off"
  };
}

function pricingCatalogDataUrl(catalog: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(catalog))}`;
}

function workflowInspect(input: {
  workflowRunId: string;
  status?: string;
  state?: string;
  error?: unknown;
  failedChildKeys?: string[];
  includeVerifierSteps?: boolean;
  steps: Array<{ id: string; state: string; attempt?: number }>;
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
            : [step, { id: verifierId, state: "finished", attempt: step.attempt }];
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
        computedAt: "2026-07-03T00:00:03.000Z",
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

async function compileInvariantCampaignBudgetFixture(input: {
  logicalNodeId: "stateful-invariant-campaign" | "stateful-invariant-recon-campaign";
  nodeTimeoutSeconds: number;
  smokeTimeoutSeconds: number;
  fuzzerTimeoutSeconds: number;
  runId: string;
}) {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: input.runId, env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const node = plan.value!.expanded_graph.nodes.find((candidate) => candidate.id === "project-discovery");
  assert.notEqual(node, undefined);
  node!.logicalId = input.logicalNodeId;
  node!.timeoutSeconds = input.nodeTimeoutSeconds;
  plan.value!.resolved_config.invariants.invariantTestingSmokeTimeoutSeconds = input.smokeTimeoutSeconds;
  plan.value!.resolved_config.invariants.invariantTestingFuzzerTimeoutSeconds = input.fuzzerTimeoutSeconds;
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  return compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: `ultrafuzz-${input.runId}`,
    renderedPrompts: plan.value!.rendered_prompts
  });
}

function writeOutOfOrderTopology(project: string): void {
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

const V0_0_2_STOCK_CODEX_ADAPTER = [
  'import { CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";',
  "",
  "export const CodexAgent = new SmithersCodexAgent({",
  '  model: "gpt-5.5",',
  "  skipGitRepoCheck: true,",
  "  apiKey: process.env.OPENAI_API_KEY,",
  "});",
  ""
].join("\n");

test(
  "init supports Modal-style directory and child device splits without weakening file identity checks",
  { concurrency: false, skip: process.platform === "win32" || !fs.existsSync("/proc/self/fd") },
  () => {
    const fstatDescriptor = Object.getOwnPropertyDescriptor(fs, "fstatSync")!;
    const lstatDescriptor = Object.getOwnPropertyDescriptor(fs, "lstatSync")!;
    const statDescriptor = Object.getOwnPropertyDescriptor(fs, "statSync")!;
    const originalFstatSync = fs.fstatSync;
    const originalLstatSync = fs.lstatSync;
    const originalStatSync = fs.statSync;
    let mismatchedPath: string | undefined;
    let mismatchInjected = false;

    const modalizeDirectoryDevice = <T extends fs.Stats | fs.BigIntStats | undefined>(value: T): T => {
      if (value !== undefined && value.isDirectory()) {
        if (typeof value.dev === "bigint") (value as fs.BigIntStats).dev += 1_000_000n;
        else (value as fs.Stats).dev += 1_000_000;
      }
      return value;
    };

    Object.defineProperty(fs, "fstatSync", {
      ...fstatDescriptor,
      value: (...args: unknown[]) => {
        const result = modalizeDirectoryDevice(Reflect.apply(originalFstatSync, fs, args) as fs.Stats | fs.BigIntStats);
        if (mismatchedPath !== undefined && !result.isDirectory()) {
          try {
            if (fs.readlinkSync(`/proc/self/fd/${String(args[0])}`) === mismatchedPath) {
              const mutable = result as fs.BigIntStats;
              mutable.ino += 1n;
              mismatchInjected = true;
            }
          } catch {
            // Let the real descriptor operation determine invalid-fd behavior.
          }
        }
        return result;
      }
    });
    Object.defineProperty(fs, "lstatSync", {
      ...lstatDescriptor,
      value: (...args: unknown[]) =>
        modalizeDirectoryDevice(Reflect.apply(originalLstatSync, fs, args) as fs.Stats | fs.BigIntStats | undefined)
    });
    Object.defineProperty(fs, "statSync", {
      ...statDescriptor,
      value: (...args: unknown[]) =>
        modalizeDirectoryDevice(Reflect.apply(originalStatSync, fs, args) as fs.Stats | fs.BigIntStats | undefined)
    });

    try {
      const project = tempProject();
      const initialized = initProject({ projectRoot: project, force: true });
      assert.equal(initialized.ok, true, JSON.stringify(initialized.diagnostics));
      assert.notEqual(
        fs.lstatSync(project, { bigint: true }).dev,
        fs.lstatSync(path.join(project, "ultrafuzz.toml"), { bigint: true }).dev
      );

      const codexPath = path.join(project, ".smithers", "agents", "codex.ts");
      fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
      const upgraded = initProject({ projectRoot: project });
      assert.equal(upgraded.ok, true, JSON.stringify(upgraded.diagnostics));
      assert.match(fs.readFileSync(codexPath, "utf8"), /process\.env\.ULTRAFUZZ_CONFIG_PATH/u);

      const attackedProject = tempProject();
      mismatchedPath = path.join(attackedProject, "ultrafuzz.toml");
      fs.writeFileSync(mismatchedPath, "# must remain intact\n", "utf8");
      const rejected = initProject({ projectRoot: attackedProject, force: true });
      assert.equal(mismatchInjected, true);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.diagnostics[0]?.code, "INIT_PATH_UNSAFE");
      assert.equal(fs.readFileSync(mismatchedPath, "utf8"), "# must remain intact\n");
    } finally {
      Object.defineProperty(fs, "fstatSync", fstatDescriptor);
      Object.defineProperty(fs, "lstatSync", lstatDescriptor);
      Object.defineProperty(fs, "statSync", statDescriptor);
    }
  }
);

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
  assert.match(codexAgentText, /import \{ readRootStringTable, readStringTable, stringField \} from ".\/toml";/);
  assert.doesNotMatch(codexAgentText, /function readStringTable/);
  assert.match(tomlHelperText, /export function readRootStringTable/);
  // TOML's \UXXXXXXXX has no JSON equivalent, so values are not JSON.parse'd.
  assert.doesNotMatch(tomlHelperText, /JSON\.parse/);
  assert.match(tomlHelperText, /escape !== "u" && escape !== "U"/);
  assert.match(codexAgentText, /const apiKey = requiredEnv/);
  assert.match(codexAgentText, /const credentialEnv = config\.api_key_env \?\? "OPENAI_API_KEY"/);
  assert.match(codexAgentText, /\[credentialEnv\]: apiKey/);
  assert.match(codexAgentText, /return { apiKey, \.\.\.\(configDir === undefined \? \{\} : \{ configDir \}\), env }/);
  assert.match(codexAgentText, /const env: Record<string, string> = { OPENAI_API_KEY: "", CODEX_API_KEY: "" };/);
  assert.match(codexAgentText, /function addCodexProviderRoute/);
  assert.match(codexAgentText, /function codexProviderRouting/);
  assert.match(codexAgentText, /function validateOpenRouterCredential/);
  assert.match(codexAgentText, /env\.OPENAI_BASE_URL = routing\.route\.baseUrl/);
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
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/opencode.ts")), true);
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/pi.ts")), true);
  const agentsIndexText = fs.readFileSync(path.join(project, ".smithers/agents/index.ts"), "utf8");
  assert.match(agentsIndexText, /export \{ createCodexAgent \} from ".\/codex";/);
  assert.match(agentsIndexText, /export \{ createClaudeAgent \} from ".\/claude";/);
  assert.match(agentsIndexText, /export \{ createDeepSeekAgent \} from ".\/deepseek";/);
  assert.match(agentsIndexText, /export \{ createKimiAgent \} from ".\/kimi";/);
  assert.match(agentsIndexText, /export \{ createOpenCodeAgent \} from ".\/opencode";/);
  assert.match(agentsIndexText, /export \{ createPiAgent \} from ".\/pi";/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*ClaudeAgent: createClaudeAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*CodexAgent: createCodexAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*DeepSeekAgent: createDeepSeekAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*KimiAgent: createKimiAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*OpenCodeAgent: createOpenCodeAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*PiAgent: createPiAgent/);
  // Importing the registry must not construct any agent: doing so reads that
  // agent's auth and fails a project that only uses the other backend.
  assert.doesNotMatch(agentsIndexText, /=\s*create(Codex|Claude|DeepSeek|Kimi|Pi|OpenCode)Agent\(\)/);
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
  assert.match(deepSeekAgentText, /reasoningTokens: undefined/);
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
  const piAgentText = fs.readFileSync(path.join(project, ".smithers/agents/pi.ts"), "utf8");
  assert.match(piAgentText, /PiAgent as SmithersPiAgent/);
  assert.match(piAgentText, /createPiAgent/);
  // The provider is the adapter's identity, not a configuration field.
  assert.match(piAgentText, /PI_PROVIDER = "openrouter"/);
  assert.match(piAgentText, /provider: PI_PROVIDER/);
  assert.match(piAgentText, /OPENROUTER_API_KEY/);
  assert.match(piAgentText, /PI_CODING_AGENT_DIR/);
  assert.match(piAgentText, /sessionDir: auth\.sessionDir/);
  assert.match(piAgentText, /import \{ readStringTable, stringField \} from ".\/toml";/);
  // `apiKey` is the only Smithers option that emits `--api-key`; the adapter
  // must never set it, and must never assemble argv of its own.
  assert.doesNotMatch(piAgentText, /apiKey:/);
  assert.doesNotMatch(piAgentText, /"--api-key"/);
  assert.doesNotMatch(piAgentText, /extraArgs/);
  assert.doesNotMatch(piAgentText, /baseURL|baseUrl|OPENROUTER_BASE_URL/);
  // pi owns the model catalogue; the profile supplies an opaque id.
  assert.doesNotMatch(piAgentText, /model:\s*"[\w./-]+"/);
  assert.doesNotMatch(piAgentText, /PI_CODING_AGENT_SESSION_DIR/);
  assert.doesNotMatch(piAgentText, /=\s*createPiAgent\(\)/);
  assert.doesNotMatch(piAgentText, /function readStringTable/);

  const openCodeAgentText = fs.readFileSync(path.join(project, ".smithers/agents/opencode.ts"), "utf8");
  assert.match(openCodeAgentText, /OpenCodeAgent as SmithersOpenCodeAgent/);
  assert.match(openCodeAgentText, /createOpenCodeAgent/);
  assert.match(openCodeAgentText, /class CompatibleOpenCodeAgent extends SmithersOpenCodeAgent/);
  assert.match(openCodeAgentText, /override async buildCommand/);
  assert.match(openCodeAgentText, /extraArgs: \["--pure"\]/);
  assert.match(openCodeAgentText, /yolo: true/);
  assert.match(openCodeAgentText, /import \{ readStringTable, stringField \} from ".\/toml";/);
  // Isolation is only real if every state root is named: an unnamed root is
  // inherited and lands in the operator's home.
  for (const name of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_DB",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_MODELS_PATH",
    "OPENCODE_TUI_CONFIG",
    "OPENCODE_PLUGIN_META_FILE",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENCODE_DISABLE_SHARE",
    "OPENCODE_DISABLE_MODELS_FETCH",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENCODE_DISABLE_LSP_DOWNLOAD"
  ]) {
    assert.match(openCodeAgentText, new RegExp(`${name}:`, "u"), `${name} is not pinned by the OpenCode adapter`);
  }
  // The adapter stays tight: it delegates argv, prompt assembly, output
  // interpretation, usage accounting, and session handling to Smithers.
  assert.doesNotMatch(openCodeAgentText, /=\s*createOpenCodeAgent\(\)/);
  assert.doesNotMatch(openCodeAgentText, /createOutputInterpreter|override async generate|override stream/);
  assert.doesNotMatch(openCodeAgentText, /mkdirSync|writeFileSync|rmSync/);
  assert.doesNotMatch(openCodeAgentText, /model:\s*"openrouter\//);

  const validate = await validateProject({ projectRoot: project, env: {} });
  assert.equal(validate.ok, true, JSON.stringify(validate.diagnostics));
  assert.equal(validate.value?.policy_posture.trust.status, "pass");
  assert.equal(validate.value?.policy_posture.agents.status, "pass");
  assert.equal(validate.value?.policy_posture.paths.status, "pass");
  assert.equal(validate.value?.resolved_config?.default_agent, "CodexAgent");
  assert.equal(validate.value?.resolved_config?.default_model, "gpt-5.5");
  assert.equal(validate.value?.resolved_config?.default_reasoning, "xhigh");
});

test("non-force init upgrades an exact historical stock agent adapter and is idempotent", () => {
  assert.equal(
    crypto.createHash("sha256").update(V0_0_2_STOCK_CODEX_ADAPTER).digest("hex"),
    "26dae14e43c09dbe7901aa731cd552b282d502d86cea8cc6726e4a8579cd3236"
  );
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const codexPath = path.join(project, ".smithers", "agents", "codex.ts");
  const environmentPath = path.join(project, ".smithers", "agents", "environment.ts");
  fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
  const historicalStats = fs.statSync(codexPath, { bigint: true });
  fs.unlinkSync(environmentPath);

  const upgraded = initProject({ projectRoot: project });

  assert.equal(upgraded.ok, true, JSON.stringify(upgraded.diagnostics));
  assert.deepEqual(
    upgraded.diagnostics
      .filter((diagnostic) => diagnostic.code === "INIT_STOCK_AGENT_ADAPTER_UPGRADED")
      .map((diagnostic) => diagnostic.path),
    [".smithers/agents/codex.ts"]
  );
  const upgradedSource = fs.readFileSync(codexPath, "utf8");
  const upgradedStats = fs.statSync(codexPath, { bigint: true });
  assert.notEqual(upgradedStats.ino, historicalStats.ino);
  assert.equal(upgradedStats.mode, historicalStats.mode);
  assert.equal(
    fs.readdirSync(path.dirname(codexPath)).some((entry) => entry.includes(".ultrafuzz-init-")),
    false
  );
  assert.match(upgradedSource, /process\.env\.ULTRAFUZZ_CONFIG_PATH/u);
  assert.match(upgradedSource, /workflowControlChildEnvironment/u);
  assert.equal(fs.existsSync(environmentPath), true);
  const recreatedEnvironmentSource = fs.readFileSync(environmentPath, "utf8");
  for (const name of [
    "ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR",
    "ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT",
    "ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR",
    "ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT"
  ]) {
    assert.match(recreatedEnvironmentSource, new RegExp(`"${name}"`, "u"));
  }

  const repeated = initProject({ projectRoot: project });
  assert.equal(repeated.ok, true, JSON.stringify(repeated.diagnostics));
  assert.equal(
    repeated.diagnostics.some((diagnostic) => diagnostic.code === "INIT_STOCK_AGENT_ADAPTER_UPGRADED"),
    false
  );
  assert.equal(fs.readFileSync(codexPath, "utf8"), upgradedSource);
});

test("non-force init upgrades a read-only stock adapter and preserves its mode", () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const codexPath = path.join(project, ".smithers", "agents", "codex.ts");
  fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
  fs.chmodSync(codexPath, 0o444);

  const upgraded = initProject({ projectRoot: project });

  assert.equal(upgraded.ok, true, JSON.stringify(upgraded.diagnostics));
  assert.match(fs.readFileSync(codexPath, "utf8"), /process\.env\.ULTRAFUZZ_CONFIG_PATH/u);
  assert.equal(fs.statSync(codexPath).mode & 0o777, 0o444);
});

test(
  "stock adapter migration restores a customization installed at the publication boundary",
  { concurrency: false },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const agentsDirectory = path.join(project, ".smithers", "agents");
    const codexPath = path.join(agentsDirectory, "codex.ts");
    const concurrentPath = path.join(agentsDirectory, "concurrent-codex.ts");
    const customized = 'export const concurrentCustomization = "must survive init";\n';
    fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
    fs.writeFileSync(concurrentPath, customized, "utf8");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "renameSync")!;
    const originalRenameSync = fs.renameSync;
    let injected = false;

    Object.defineProperty(fs, "renameSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        const [source, destination] = args.map(String);
        if (
          !injected &&
          path.basename(source ?? "") === "codex.ts" &&
          path.basename(destination ?? "") === ".codex.ts.ultrafuzz-init-previous"
        ) {
          injected = true;
          Reflect.apply(originalRenameSync, fs, [concurrentPath, codexPath]);
        }
        return Reflect.apply(originalRenameSync, fs, args) as void;
      }
    });
    try {
      const failed = initProject({ projectRoot: project });
      assert.equal(injected, true);
      assert.equal(failed.ok, false);
      assert.equal(failed.diagnostics[0]?.code, "INIT_PATH_UNSAFE");
      assert.equal(fs.readFileSync(codexPath, "utf8"), customized);
      assert.equal(
        fs.readdirSync(agentsDirectory).some((entry) => entry.includes(".ultrafuzz-init-")),
        false
      );
    } finally {
      Object.defineProperty(fs, "renameSync", originalDescriptor);
    }
  }
);

test(
  "stock adapter migration recovers after process death with the target quarantined",
  { concurrency: false, skip: process.platform === "win32" },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const agentsDirectory = path.join(project, ".smithers", "agents");
    const codexPath = path.join(agentsDirectory, "codex.ts");
    fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
    const runtimeUrl = new URL("../../dist/index.js", import.meta.url).href;
    const crashScript = String.raw`
      import fs from "node:fs";
      import path from "node:path";
      const project = process.argv[1];
      const runtimeUrl = process.argv[2];
      const { initProject } = await import(runtimeUrl);
      const originalRenameSync = fs.renameSync;
      Object.defineProperty(fs, "renameSync", {
        ...Object.getOwnPropertyDescriptor(fs, "renameSync"),
        value: (...args) => {
          const result = Reflect.apply(originalRenameSync, fs, args);
          if (
            path.basename(String(args[0])) === "codex.ts" &&
            path.basename(String(args[1])) === ".codex.ts.ultrafuzz-init-previous"
          ) process.exit(86);
          return result;
        }
      });
      initProject({ projectRoot: project });
      process.exit(87);
    `;

    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashScript, project, runtimeUrl], {
      encoding: "utf8"
    });
    assert.equal(crashed.status, 86, crashed.stderr);
    assert.equal(fs.existsSync(codexPath), false);
    assert.equal(fs.existsSync(path.join(agentsDirectory, ".codex.ts.ultrafuzz-init-recovery")), true);

    const recovered = initProject({ projectRoot: project });

    assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
    assert.match(fs.readFileSync(codexPath, "utf8"), /process\.env\.ULTRAFUZZ_CONFIG_PATH/u);
    assert.equal(
      fs.readdirSync(agentsDirectory).some((entry) => entry.includes(".ultrafuzz-init-")),
      false
    );
    assert.deepEqual(openDescriptorTargetsInside(agentsDirectory), []);
  }
);

test(
  "stock adapter migration recovers after process death immediately after marker creation",
  { concurrency: false, skip: process.platform === "win32" },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const agentsDirectory = path.join(project, ".smithers", "agents");
    const codexPath = path.join(agentsDirectory, "codex.ts");
    const recoveryMarkerPath = path.join(agentsDirectory, ".codex.ts.ultrafuzz-init-recovery");
    fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
    const runtimeUrl = new URL("../../dist/index.js", import.meta.url).href;
    const crashScript = String.raw`
      import fs from "node:fs";
      const project = process.argv[1];
      const runtimeUrl = process.argv[2];
      const { initProject } = await import(runtimeUrl);
      const originalOpenSync = fs.openSync;
      Object.defineProperty(fs, "openSync", {
        ...Object.getOwnPropertyDescriptor(fs, "openSync"),
        value: (...args) => {
          const descriptor = Reflect.apply(originalOpenSync, fs, args);
          if (String(args[0]).endsWith(".codex.ts.ultrafuzz-init-recovery")) process.exit(86);
          return descriptor;
        }
      });
      initProject({ projectRoot: project });
      process.exit(87);
    `;

    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashScript, project, runtimeUrl], {
      encoding: "utf8"
    });
    assert.equal(crashed.status, 86, crashed.stderr);
    assert.equal(fs.statSync(recoveryMarkerPath).size, 0);
    assert.equal(fs.existsSync(path.join(agentsDirectory, ".codex.ts.ultrafuzz-init-prepared")), true);
    assert.equal(fs.existsSync(path.join(agentsDirectory, ".codex.ts.ultrafuzz-init-previous")), true);

    const recovered = initProject({ projectRoot: project });

    assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
    assert.match(fs.readFileSync(codexPath, "utf8"), /process\.env\.ULTRAFUZZ_CONFIG_PATH/u);
    assert.equal(
      fs.readdirSync(agentsDirectory).some((entry) => entry.includes(".ultrafuzz-init-")),
      false
    );
  }
);

test(
  "stock adapter migration leaves the original intact when temporary publication fails",
  { concurrency: false },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const agentsDirectory = path.join(project, ".smithers", "agents");
    const codexPath = path.join(agentsDirectory, "codex.ts");
    fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
    const entriesBefore = fs.readdirSync(agentsDirectory).sort();
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync")!;

    Object.defineProperty(fs, "writeSync", {
      ...originalDescriptor,
      value: (..._args: unknown[]) => {
        throw new Error("induced temporary publication write failure");
      }
    });
    try {
      const failed = initProject({ projectRoot: project });
      assert.equal(failed.ok, false);
      assert.equal(failed.diagnostics[0]?.code, "INIT_PATH_UNSAFE");
      assert.equal(fs.readFileSync(codexPath, "utf8"), V0_0_2_STOCK_CODEX_ADAPTER);
      assert.deepEqual(fs.readdirSync(agentsDirectory).sort(), entriesBefore);
    } finally {
      Object.defineProperty(fs, "writeSync", originalDescriptor);
    }
  }
);

test(
  "stock adapter migration retains and recovers a deterministic path when cleanup fails",
  { concurrency: false },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const agentsDirectory = path.join(project, ".smithers", "agents");
    const codexPath = path.join(agentsDirectory, "codex.ts");
    const preparedPath = path.join(agentsDirectory, ".codex.ts.ultrafuzz-init-prepared");
    fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
    const writeDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync")!;
    const unlinkDescriptor = Object.getOwnPropertyDescriptor(fs, "unlinkSync")!;
    const originalUnlinkSync = fs.unlinkSync;

    Object.defineProperty(fs, "writeSync", {
      ...writeDescriptor,
      value: (..._args: unknown[]) => {
        throw new Error("induced publication failure before recovery marker creation");
      }
    });
    Object.defineProperty(fs, "unlinkSync", {
      ...unlinkDescriptor,
      value: (...args: unknown[]) => {
        if (path.basename(String(args[0])) === path.basename(preparedPath)) {
          throw Object.assign(new Error("induced prepared-file cleanup failure"), { code: "EIO" });
        }
        return Reflect.apply(originalUnlinkSync, fs, args) as void;
      }
    });
    try {
      const failed = initProject({ projectRoot: project });
      assert.equal(failed.ok, false);
      assert.equal(fs.existsSync(preparedPath), true);
      assert.equal(fs.readFileSync(codexPath, "utf8"), V0_0_2_STOCK_CODEX_ADAPTER);
    } finally {
      Object.defineProperty(fs, "writeSync", writeDescriptor);
      Object.defineProperty(fs, "unlinkSync", unlinkDescriptor);
    }

    const recovered = initProject({ projectRoot: project });
    assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
    assert.equal(fs.existsSync(preparedPath), false);
    assert.match(fs.readFileSync(codexPath, "utf8"), /process\.env\.ULTRAFUZZ_CONFIG_PATH/u);
  }
);

test(
  "stock adapter migration removes its temporary file when the first temporary fstat fails",
  { concurrency: false, skip: process.platform === "win32" || !fs.existsSync("/proc/self/fd") },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const agentsDirectory = path.join(project, ".smithers", "agents");
    const codexPath = path.join(agentsDirectory, "codex.ts");
    fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "fstatSync")!;
    const originalFstatSync = fs.fstatSync;
    let induced = false;

    Object.defineProperty(fs, "fstatSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        const descriptor = Number(args[0]);
        let target = "";
        try {
          target = fs.readlinkSync(`/proc/self/fd/${descriptor}`);
        } catch {
          // Let the real fstat report invalid descriptors.
        }
        if (!induced && target.includes(".codex.ts.ultrafuzz-init-")) {
          induced = true;
          throw Object.assign(new Error("induced first temporary fstat failure"), { code: "EIO" });
        }
        return Reflect.apply(originalFstatSync, fs, args) as fs.Stats | fs.BigIntStats;
      }
    });
    try {
      const failed = initProject({ projectRoot: project });
      assert.equal(induced, true);
      assert.equal(failed.ok, false);
      assert.equal(fs.readFileSync(codexPath, "utf8"), V0_0_2_STOCK_CODEX_ADAPTER);
      assert.equal(
        fs.readdirSync(agentsDirectory).some((entry) => entry.includes(".ultrafuzz-init-")),
        false
      );
      assert.deepEqual(openDescriptorTargetsInside(agentsDirectory), []);
    } finally {
      Object.defineProperty(fs, "fstatSync", originalDescriptor);
    }
  }
);

test(
  "stock adapter migration aggregates a failed temporary close without skipping cleanup",
  { concurrency: false, skip: process.platform === "win32" || !fs.existsSync("/proc/self/fd") },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const agentsDirectory = path.join(project, ".smithers", "agents");
    const codexPath = path.join(agentsDirectory, "codex.ts");
    fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "closeSync")!;
    const originalCloseSync = fs.closeSync;
    let induced = false;

    Object.defineProperty(fs, "closeSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        const descriptor = Number(args[0]);
        let target = "";
        try {
          target = fs.readlinkSync(`/proc/self/fd/${descriptor}`);
        } catch {
          // Let the real close report invalid descriptors.
        }
        if (!induced && target.includes(".codex.ts.ultrafuzz-init-")) {
          induced = true;
          Reflect.apply(originalCloseSync, fs, args);
          throw Object.assign(new Error("induced first temporary close failure"), { code: "EIO" });
        }
        return Reflect.apply(originalCloseSync, fs, args) as void;
      }
    });
    try {
      const upgraded = initProject({ projectRoot: project });
      assert.equal(induced, true);
      assert.equal(upgraded.ok, false, JSON.stringify(upgraded.diagnostics));
      assert.match(fs.readFileSync(codexPath, "utf8"), /process\.env\.ULTRAFUZZ_CONFIG_PATH/u);
      assert.equal(
        fs.readdirSync(agentsDirectory).some((entry) => entry.includes(".ultrafuzz-init-")),
        false
      );
      assert.deepEqual(openDescriptorTargetsInside(agentsDirectory), []);
    } finally {
      Object.defineProperty(fs, "closeSync", originalDescriptor);
    }
  }
);

test(
  "init converts an adapter inspection failure into a preserved manual-review warning",
  { concurrency: false },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const codexPath = path.join(project, ".smithers", "agents", "codex.ts");
    const customized = 'export const customConfig = "ultrafuzz.toml"; // project-owned adapter\n';
    fs.writeFileSync(codexPath, customized, "utf8");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
    const originalOpenSync = fs.openSync;
    let codexOpenCount = 0;

    Object.defineProperty(fs, "openSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        if (String(args[0]) === codexPath) {
          codexOpenCount += 1;
          if (codexOpenCount === 2) {
            throw Object.assign(new Error("induced sensitive adapter inspection failure"), { code: "EACCES" });
          }
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      }
    });
    try {
      const preserved = initProject({ projectRoot: project });
      assert.equal(preserved.ok, true, JSON.stringify(preserved.diagnostics));
      assert.equal(codexOpenCount, 2);
      assert.equal(fs.readFileSync(codexPath, "utf8"), customized);
      const warning = preserved.diagnostics.find(
        (diagnostic) =>
          diagnostic.code === "INIT_AGENT_ADAPTER_UPDATE_REQUIRED" && diagnostic.path === ".smithers/agents/codex.ts"
      );
      assert.equal(warning?.severity, "warning");
      assert.match(warning?.message ?? "", /could not be safely inspected/u);
      assert.match(warning?.message ?? "", /verify manually/u);
      assert.doesNotMatch(JSON.stringify(preserved.diagnostics), /induced sensitive|EACCES/u);
    } finally {
      Object.defineProperty(fs, "openSync", originalDescriptor);
    }
  }
);

test("non-force init preserves a customized stale adapter and force remains explicit", () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const codexPath = path.join(project, ".smithers", "agents", "codex.ts");
  const customized = [
    'import { readFileSync } from "node:fs";',
    'import path from "node:path";',
    'export const customConfig = readFileSync(path.join(process.cwd(), "ultrafuzz.toml"), "utf8");',
    "// project-owned customization",
    ""
  ].join("\n");
  fs.writeFileSync(codexPath, customized, "utf8");

  const preserved = initProject({ projectRoot: project });

  assert.equal(preserved.ok, true, JSON.stringify(preserved.diagnostics));
  assert.equal(fs.readFileSync(codexPath, "utf8"), customized);
  const warning = preserved.diagnostics.find(
    (diagnostic) =>
      diagnostic.code === "INIT_AGENT_ADAPTER_UPDATE_REQUIRED" && diagnostic.path === ".smithers/agents/codex.ts"
  );
  assert.equal(warning?.severity, "warning");
  assert.match(warning?.message ?? "", /process\.env\.ULTRAFUZZ_CONFIG_PATH/u);
  assert.match(warning?.message ?? "", /workflowControlChildEnvironment/u);

  const forced = initProject({ projectRoot: project, force: true });
  assert.equal(forced.ok, true, JSON.stringify(forced.diagnostics));
  assert.notEqual(fs.readFileSync(codexPath, "utf8"), customized);
  assert.match(fs.readFileSync(codexPath, "utf8"), /process\.env\.ULTRAFUZZ_CONFIG_PATH/u);
});

test("non-force init never follows or overwrites linked stock adapter paths", () => {
  for (const linkKind of ["symbolic", "hard"] as const) {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const codexPath = path.join(project, ".smithers", "agents", "codex.ts");
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ufz-init-${linkKind}-`));
    const outsidePath = path.join(outsideRoot, "codex.ts");
    fs.writeFileSync(outsidePath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
    fs.unlinkSync(codexPath);
    if (linkKind === "symbolic") {
      fs.symlinkSync(outsidePath, codexPath);
    } else {
      fs.linkSync(outsidePath, codexPath);
    }

    const preserved = initProject({ projectRoot: project });

    assert.equal(preserved.ok, true, JSON.stringify(preserved.diagnostics));
    assert.equal(fs.readFileSync(outsidePath, "utf8"), V0_0_2_STOCK_CODEX_ADAPTER);
    assert.equal(fs.readFileSync(codexPath, "utf8"), V0_0_2_STOCK_CODEX_ADAPTER);
    assert.equal(fs.lstatSync(codexPath).isSymbolicLink(), linkKind === "symbolic");
    if (linkKind === "hard") assert.equal(fs.statSync(codexPath).nlink, 2);
    const warning = preserved.diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "INIT_AGENT_ADAPTER_UPDATE_REQUIRED" && diagnostic.path === ".smithers/agents/codex.ts"
    );
    assert.match(warning?.message ?? "", /preserved it without inspection/u);
  }
});

test("startRun gives manual upgrade guidance for a customized stale adapter", async () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  writeSmallTopology(project);
  const codexPath = path.join(project, ".smithers", "agents", "codex.ts");
  fs.writeFileSync(codexPath, 'export const customConfig = "ultrafuzz.toml"; // project-owned adapter\n', "utf8");

  const run = await startRun({ projectRoot: project, runId: "stale-custom-agent", env: fakeSmithersEnv(project) });

  assert.equal(run.ok, false);
  assert.equal(run.diagnostics[0]?.code, "WORKFLOW_SUBMISSION_FAILED");
  assert.match(run.diagnostics[0]?.message ?? "", /process\.env\.ULTRAFUZZ_CONFIG_PATH/u);
  assert.match(run.diagnostics[0]?.message ?? "", /rerun ultrafuzz init/u);
  assert.match(run.diagnostics[0]?.message ?? "", /update this customized adapter manually/u);
});

test("init preserves a dangling adapter symlink without writing through it", () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const codexPath = path.join(project, ".smithers", "agents", "codex.ts");
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-init-dangling-"));
  const outsidePath = path.join(outsideRoot, "codex.ts");
  fs.unlinkSync(codexPath);
  fs.symlinkSync(outsidePath, codexPath);

  const result = initProject({ projectRoot: project });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(outsidePath), false);
  assert.equal(fs.readlinkSync(codexPath), outsidePath);
});

test("init does not modify a regular file swapped after the anchored open", { concurrency: false }, () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const environmentPath = path.join(project, ".smithers", "agents", "environment.ts");
  const originalContents = fs.readFileSync(environmentPath, "utf8");
  const concurrentContents = "export const concurrentEnvironmentCustomization = true;\n";
  const originalOpenSync = fs.openSync;
  const descriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
  let swapped = false;
  Object.defineProperty(fs, "openSync", {
    ...descriptor,
    value: (...args: unknown[]) => {
      const opened = Reflect.apply(originalOpenSync, fs, args) as number;
      if (!swapped && path.basename(String(args[0])) === "environment.ts") {
        swapped = true;
        fs.renameSync(environmentPath, `${environmentPath}.old`);
        fs.writeFileSync(environmentPath, concurrentContents, "utf8");
      }
      return opened;
    }
  });
  try {
    const result = initProject({ projectRoot: project, force: true });
    assert.equal(result.ok, false);
  } finally {
    Object.defineProperty(fs, "openSync", descriptor);
  }
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(environmentPath, "utf8"), concurrentContents);
  assert.equal(fs.readFileSync(`${environmentPath}.old`, "utf8"), originalContents);
});

test(
  "stock adapter publication retains the replacement when final directory fsync fails",
  { concurrency: false },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const agentsDirectory = path.join(project, ".smithers", "agents");
    const codexPath = path.join(agentsDirectory, "codex.ts");
    const expectedReplacement = fs.readFileSync(codexPath, "utf8");
    fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
    const originalFsyncSync = fs.fsyncSync;
    const descriptor = Object.getOwnPropertyDescriptor(fs, "fsyncSync")!;
    let directoryFsyncs = 0;
    Object.defineProperty(fs, "fsyncSync", {
      ...descriptor,
      value: (fileDescriptor: number) => {
        let target = "";
        try {
          target = fs.readlinkSync(`/proc/self/fd/${fileDescriptor}`);
        } catch {
          // Let the real fsync report invalid descriptors.
        }
        if (target === agentsDirectory) {
          directoryFsyncs += 1;
          if (directoryFsyncs === 4)
            throw Object.assign(new Error("induced final directory fsync failure"), { code: "EIO" });
        }
        return originalFsyncSync(fileDescriptor);
      }
    });
    try {
      const result = initProject({ projectRoot: project });
      assert.equal(result.ok, false);
    } finally {
      Object.defineProperty(fs, "fsyncSync", descriptor);
    }
    assert.equal(directoryFsyncs, 4);
    assert.equal(fs.readFileSync(codexPath, "utf8"), expectedReplacement);
    assert.deepEqual(
      fs.readdirSync(agentsDirectory).filter((entry) => entry.includes(".ultrafuzz-init-")),
      []
    );
  }
);

test(
  "stock adapter publication retains its recovery marker when post-displacement fsync fails",
  { concurrency: false },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const agentsDirectory = path.join(project, ".smithers", "agents");
    const codexPath = path.join(agentsDirectory, "codex.ts");
    const expectedReplacement = fs.readFileSync(codexPath, "utf8");
    fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
    const originalFsyncSync = fs.fsyncSync;
    const descriptor = Object.getOwnPropertyDescriptor(fs, "fsyncSync")!;
    let directoryFsyncs = 0;
    Object.defineProperty(fs, "fsyncSync", {
      ...descriptor,
      value: (fileDescriptor: number) => {
        let target = "";
        try {
          target = fs.readlinkSync(`/proc/self/fd/${fileDescriptor}`);
        } catch {
          // Let the real fsync report invalid descriptors.
        }
        if (target === agentsDirectory) {
          directoryFsyncs += 1;
          if (directoryFsyncs === 3)
            throw Object.assign(new Error("induced post-displacement directory fsync failure"), { code: "EIO" });
        }
        return originalFsyncSync(fileDescriptor);
      }
    });
    try {
      const result = initProject({ projectRoot: project });
      assert.equal(result.ok, false);
    } finally {
      Object.defineProperty(fs, "fsyncSync", descriptor);
    }
    assert.equal(directoryFsyncs, 3);
    assert.equal(fs.readFileSync(codexPath, "utf8"), expectedReplacement);
    assert.deepEqual(
      fs.readdirSync(agentsDirectory).filter((entry) => entry.includes(".ultrafuzz-init-")),
      [".codex.ts.ultrafuzz-init-recovery"]
    );
    assert.equal(initProject({ projectRoot: project }).ok, true);
    assert.equal(fs.existsSync(path.join(agentsDirectory, ".codex.ts.ultrafuzz-init-recovery")), false);
  }
);

test(
  "stock adapter publication restores the original when intermediate commit fsync fails",
  { concurrency: false },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const agentsDirectory = path.join(project, ".smithers", "agents");
    const codexPath = path.join(agentsDirectory, "codex.ts");
    fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
    const originalFsyncSync = fs.fsyncSync;
    const descriptor = Object.getOwnPropertyDescriptor(fs, "fsyncSync")!;
    let directoryFsyncs = 0;
    Object.defineProperty(fs, "fsyncSync", {
      ...descriptor,
      value: (fileDescriptor: number) => {
        let target = "";
        try {
          target = fs.readlinkSync(`/proc/self/fd/${fileDescriptor}`);
        } catch {
          // Let the real fsync report invalid descriptors.
        }
        if (target === agentsDirectory) {
          directoryFsyncs += 1;
          if (directoryFsyncs === 2)
            throw Object.assign(new Error("induced intermediate directory fsync failure"), { code: "EIO" });
        }
        return originalFsyncSync(fileDescriptor);
      }
    });
    try {
      const result = initProject({ projectRoot: project });
      assert.equal(result.ok, false);
    } finally {
      Object.defineProperty(fs, "fsyncSync", descriptor);
    }
    assert.equal(directoryFsyncs, 2);
    assert.equal(fs.readFileSync(codexPath, "utf8"), V0_0_2_STOCK_CODEX_ADAPTER);
    assert.deepEqual(
      fs.readdirSync(agentsDirectory).filter((entry) => entry.includes(".ultrafuzz-init-")),
      []
    );
  }
);

test(
  "stock adapter publication retains the replacement when final directory stability fails",
  { concurrency: false },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const agentsDirectory = path.join(project, ".smithers", "agents");
    const codexPath = path.join(agentsDirectory, "codex.ts");
    const expectedReplacement = fs.readFileSync(codexPath, "utf8");
    fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
    const originalLstatSync = fs.lstatSync;
    const descriptor = Object.getOwnPropertyDescriptor(fs, "lstatSync")!;
    let injected = false;
    Object.defineProperty(fs, "lstatSync", {
      ...descriptor,
      value: (...args: unknown[]) => {
        const result = Reflect.apply(originalLstatSync, fs, args) as fs.BigIntStats;
        if (
          !injected &&
          String(args[0]) === agentsDirectory &&
          !fs.existsSync(path.join(agentsDirectory, ".codex.ts.ultrafuzz-init-recovery"))
        ) {
          const target = fs.lstatSync(codexPath, { bigint: true });
          if (target.size === BigInt(Buffer.byteLength(expectedReplacement))) {
            injected = true;
            return { ...result, ino: result.ino + 1n } as fs.BigIntStats;
          }
        }
        return result;
      }
    });
    try {
      const result = initProject({ projectRoot: project });
      assert.equal(result.ok, false);
    } finally {
      Object.defineProperty(fs, "lstatSync", descriptor);
    }
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(codexPath, "utf8"), expectedReplacement);
    assert.deepEqual(
      fs.readdirSync(agentsDirectory).filter((entry) => entry.includes(".ultrafuzz-init-")),
      []
    );
  }
);

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
  "generated CodexAgent subscription auth routes the credential preflight at the CLI's configured provider",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const configPath = path.join(project, "ultrafuzz.toml");
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace(
          /\[agents\.CodexAgent\]\nauth = "api-key"\napi_key_env = "OPENAI_API_KEY"/u,
          '[agents.CodexAgent]\nauth = "subscription"'
        ),
      "utf8"
    );
    const { createCodexAgent } = await loadGeneratedCodexAgent(project);
    const codexHome = path.join(project, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });

    const agentEnvironment = (): Record<string, string> =>
      (createCodexAgent() as { opts: { env: Record<string, string> } }).opts.env;

    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      codexHome: process.env.CODEX_HOME,
      baseUrl: process.env.OPENAI_BASE_URL
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.CODEX_HOME = codexHome;
    delete process.env.OPENAI_BASE_URL;
    try {
      // No config.toml at all: unchanged behaviour, no route asserted.
      assert.equal(agentEnvironment().OPENAI_BASE_URL, undefined);

      // A provider with a base_url is adopted so preflight and the CLI agree.
      const configToml = path.join(codexHome, "config.toml");
      fs.writeFileSync(
        configToml,
        [
          'model = "gpt-5.5"',
          'model_provider = "gateway"',
          "",
          "[model_providers.gateway]",
          'base_url = "http://127.0.0.1:2455/backend-api/codex"',
          'wire_api = "responses"'
        ].join("\n"),
        "utf8"
      );
      assert.equal(agentEnvironment().OPENAI_BASE_URL, "http://127.0.0.1:2455/backend-api/codex");
      // Subscription auth still refuses to hand a key to the child.
      assert.equal(agentEnvironment().OPENAI_API_KEY, "");
      assert.equal(agentEnvironment().CODEX_API_KEY, "");

      // A quoted provider id in the table header resolves identically.
      fs.writeFileSync(
        configToml,
        [
          'model_provider = "my gateway"',
          "",
          '[model_providers."my gateway"]',
          'base_url = "https://gateway.example/v1"'
        ].join("\n"),
        "utf8"
      );
      assert.equal(agentEnvironment().OPENAI_BASE_URL, "https://gateway.example/v1");

      // The selected provider remains authoritative over an ambient route.
      process.env.OPENAI_BASE_URL = "https://operator.example/v1";
      assert.equal(agentEnvironment().OPENAI_BASE_URL, "https://gateway.example/v1");
      delete process.env.OPENAI_BASE_URL;

      // Default provider, unknown provider, and a provider without base_url all
      // fall back to the public API rather than failing the run.
      fs.writeFileSync(configToml, 'model = "gpt-5.5"\n', "utf8");
      assert.equal(agentEnvironment().OPENAI_BASE_URL, undefined);
      fs.writeFileSync(configToml, 'model_provider = "absent"\n', "utf8");
      assert.equal(agentEnvironment().OPENAI_BASE_URL, undefined);
      fs.writeFileSync(
        configToml,
        ['model_provider = "gateway"', "", "[model_providers.gateway]", 'wire_api = "responses"'].join("\n"),
        "utf8"
      );
      assert.equal(agentEnvironment().OPENAI_BASE_URL, undefined);

      // A malformed escape must not escape as an uncaught render-time throw.
      fs.writeFileSync(configToml, 'model_provider = "bad\\q"\n', "utf8");
      assert.equal(agentEnvironment().OPENAI_BASE_URL, undefined);
    } finally {
      if (previous.config === undefined) delete process.env.ULTRAFUZZ_CONFIG_PATH;
      else process.env.ULTRAFUZZ_CONFIG_PATH = previous.config;
      if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous.codexHome;
      if (previous.baseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previous.baseUrl;
    }
  }
);

test(
  "generated CodexAgent API-key auth preflights the configured custom provider with its named credential",
  { skip: !runningUnderBun },
  async () => {
    const codexVersion = spawnSync("codex", ["--version"], { encoding: "utf8" });
    const realCodexCliAvailable = codexVersion.status === 0 && codexVersion.stdout.includes("codex-cli");
    let acceptCredential = true;
    const requests: Array<{ authorization: string | undefined; method: string | undefined; url: string | undefined }> =
      [];
    const server = createServer((request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        method: request.method,
        url: request.url
      });
      if (request.method === "POST" && request.url === "/v1/responses") {
        const outputText = { type: "output_text", text: "fixture-ok", annotations: [], logprobs: [] };
        const message = {
          id: "msg_fixture",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [outputText]
        };
        const completed = {
          id: "resp_fixture",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "fixture-model",
          output: [message],
          parallel_tool_calls: true,
          tool_choice: "auto",
          tools: [],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2
          }
        };
        const events = [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, status: "in_progress", content: [] }
          },
          {
            type: "response.content_part.added",
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            part: { ...outputText, text: "" }
          },
          {
            type: "response.output_text.delta",
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: outputText.text,
            logprobs: []
          },
          {
            type: "response.output_text.done",
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            text: outputText.text,
            logprobs: []
          },
          {
            type: "response.content_part.done",
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            part: outputText
          },
          { type: "response.output_item.done", output_index: 0, item: message },
          { type: "response.completed", response: completed }
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `${events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}`).join("\n\n")}\n\ndata: [DONE]\n\n`
        );
        return;
      }
      if (request.url === "/v1/key" && !acceptCredential) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end('{"error":{"message":"invalid fixture key"}}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url === "/v1/key" ? '{"data":{"label":"fixture"}}' : '{"data":[]}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    server.unref();

    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const configPath = path.join(project, "ultrafuzz.toml");
    const codexHome = path.join(project, "openrouter-codex");
    fs.mkdirSync(codexHome, { recursive: true });
    const address = server.address() as AddressInfo;
    const providerBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    const codexConfigPath = path.join(codexHome, "config.toml");
    const openRouterCodexConfig = [
      'model_provider = "openrouter"',
      "",
      "[model_providers.openrouter]",
      'name = "OpenRouter fixture"',
      `base_url = "${providerBaseUrl}"`,
      'wire_api = "responses"',
      'env_key = "OPENROUTER_API_KEY"'
    ].join("\n");
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace(
          /\[agents\.CodexAgent\]\nauth = "api-key"\napi_key_env = "OPENAI_API_KEY"/u,
          [
            "[agents.CodexAgent]",
            'auth = "api-key"',
            'api_key_env = "OPENROUTER_API_KEY"',
            `config_dir = ${JSON.stringify(codexHome)}`
          ].join("\n")
        ),
      "utf8"
    );

    const previous = {
      baseUrl: process.env.OPENAI_BASE_URL,
      codexHome: process.env.CODEX_HOME,
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      openRouterKey: process.env.OPENROUTER_API_KEY
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.OPENROUTER_API_KEY = "openrouter-test-key";
    delete process.env.CODEX_HOME;
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:1/ambient-must-not-receive-key";
    try {
      const { createCodexAgent } = await loadGeneratedCodexAgent(project);
      // A dedicated Codex home is not itself evidence of a custom provider.
      // Keep normal OpenAI/ambient routing when config.toml is absent or only
      // contains default-provider settings.
      const noCodexConfigAgent = createCodexAgent() as {
        opts: { configDir: string; env: Record<string, string> };
      };
      assert.equal(noCodexConfigAgent.opts.configDir, codexHome);
      assert.equal(noCodexConfigAgent.opts.env.OPENAI_BASE_URL, undefined);
      fs.writeFileSync(codexConfigPath, 'model = "gpt-5.5"\n', "utf8");
      const defaultProviderAgent = createCodexAgent() as typeof noCodexConfigAgent;
      assert.equal(defaultProviderAgent.opts.env.OPENAI_BASE_URL, undefined);

      fs.writeFileSync(codexConfigPath, openRouterCodexConfig, "utf8");
      const agent = createCodexAgent() as {
        opts: {
          apiKey: string;
          configDir: string;
          env: Record<string, string>;
        };
        preflight(options?: { rootDir?: string }): Promise<void>;
        buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
          command: string;
          args: string[];
          env?: Record<string, string>;
          stdin?: string;
          cleanup?: () => Promise<void>;
        }>;
      };
      assert.equal(agent.opts.apiKey, "openrouter-test-key");
      assert.equal(agent.opts.configDir, codexHome);
      assert.equal(agent.opts.env.OPENAI_BASE_URL, providerBaseUrl);
      assert.equal(agent.opts.env.OPENROUTER_API_KEY, "openrouter-test-key");

      if (!realCodexCliAvailable) {
        return;
      }
      await agent.preflight({ rootDir: project });
      assert.deepEqual(requests, [
        { authorization: "Bearer openrouter-test-key", method: "GET", url: "/v1/models" },
        { authorization: "Bearer openrouter-test-key", method: "GET", url: "/v1/models" },
        { authorization: "Bearer openrouter-test-key", method: "GET", url: "/v1/key" }
      ]);

      const command = await agent.buildCommand({
        prompt: "Reply with exactly fixture-ok and do not use tools.",
        cwd: project,
        options: {}
      });
      try {
        const execution = spawnSync(command.command, command.args, {
          cwd: project,
          encoding: "utf8",
          env: { ...process.env, ...agent.opts.env, ...command.env },
          input: command.stdin,
          timeout: 20_000
        });
        assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
        assert.match(execution.stdout, /fixture-ok/u);
        assert.deepEqual(requests.at(-1), {
          authorization: "Bearer openrouter-test-key",
          method: "POST",
          url: "/v1/responses"
        });
      } finally {
        await command.cleanup?.();
      }

      acceptCredential = false;
      await assert.rejects(
        agent.preflight({ rootDir: project }),
        /OpenRouter credential is invalid \(401 Unauthorized\)/u
      );
      assert.deepEqual(requests.at(-1), {
        authorization: "Bearer openrouter-test-key",
        method: "GET",
        url: "/v1/key"
      });

      // Codex accepts literal strings and comments after table headers, while
      // the generated adapters intentionally share a smaller TOML reader. If
      // route discovery cannot decode otherwise valid Codex TOML, preflight
      // must not send the provider key to an inherited/default endpoint. The
      // real CLI remains the authoritative parser and still executes it.
      acceptCredential = true;
      requests.length = 0;
      fs.writeFileSync(
        path.join(codexHome, "config.toml"),
        [
          "model_provider = 'openrouter'",
          "",
          "[model_providers.openrouter] # valid TOML outside the shared reader's subset",
          "name = 'OpenRouter fixture'",
          `base_url = '${providerBaseUrl}'`,
          "wire_api = 'responses'",
          "env_key = 'OPENROUTER_API_KEY'"
        ].join("\n"),
        "utf8"
      );
      const alternateTomlAgent = createCodexAgent() as typeof agent;
      assert.equal(alternateTomlAgent.opts.env.OPENAI_BASE_URL, "");
      await alternateTomlAgent.preflight({ rootDir: project });
      assert.deepEqual(requests, []);

      const alternateTomlCommand = await alternateTomlAgent.buildCommand({
        prompt: "Reply with exactly fixture-ok and do not use tools.",
        cwd: project,
        options: {}
      });
      try {
        const execution = spawnSync(alternateTomlCommand.command, alternateTomlCommand.args, {
          cwd: project,
          encoding: "utf8",
          env: { ...process.env, ...alternateTomlAgent.opts.env, ...alternateTomlCommand.env },
          input: alternateTomlCommand.stdin,
          timeout: 20_000
        });
        assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
        assert.match(execution.stdout, /fixture-ok/u);
        assert.deepEqual(requests, [
          {
            authorization: "Bearer openrouter-test-key",
            method: "POST",
            url: "/v1/responses"
          }
        ]);
      } finally {
        await alternateTomlCommand.cleanup?.();
      }
    } finally {
      if (previous.baseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previous.baseUrl;
      if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous.codexHome;
      if (previous.config === undefined) delete process.env.ULTRAFUZZ_CONFIG_PATH;
      else process.env.ULTRAFUZZ_CONFIG_PATH = previous.config;
      if (previous.openRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous.openRouterKey;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }
);

test(
  "generated agents cannot relabel an aliased execution-snapshot path as a credential",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const configPath = path.join(project, "ultrafuzz.toml");
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, "utf8").replace('api_key_env = "OPENAI_API_KEY"', 'api_key_env = "MY_ALIAS"'),
      "utf8"
    );
    const snapshotRoot = path.join(
      project,
      ".ultrafuzz",
      "runs",
      "alias-boundary",
      "smithers",
      "execution-snapshots",
      "a".repeat(64)
    );
    const persistedWorkflow = path.join(snapshotRoot, ".smithers", "workflows", "alias-boundary.tsx");
    const aliasedControlPath = path.join(snapshotRoot, "controls", "ultrafuzz.toml");
    const source = {
      ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: persistedWorkflow,
      ULTRAFUZZ_CONFIG_PATH: configPath,
      ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR: "3",
      ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT: snapshotRoot,
      ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR: "17",
      ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT: `/proc/${process.pid}/fd/17`,
      MY_ALIAS: aliasedControlPath
    };
    const { createCodexAgent, workflowControlChildEnvironment } = await loadGeneratedCodexAgent(project);
    const sanitized = workflowControlChildEnvironment(
      {
        CODEX_API_KEY: aliasedControlPath,
        REAL_API_KEY: "real-key",
        ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR: "3",
        ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT: snapshotRoot,
        ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR: "19",
        ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT: `/proc/${process.pid}/fd/19`
      },
      source
    );
    assert.equal(sanitized.CODEX_API_KEY, "");
    assert.equal(sanitized.MY_ALIAS, "");
    assert.equal(sanitized.REAL_API_KEY, "real-key");
    for (const name of [
      "ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR",
      "ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT",
      "ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR",
      "ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT"
    ]) {
      assert.equal(sanitized[name], "", `${name} escaped into a model child environment`);
    }

    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      workflow: process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH,
      alias: process.env.MY_ALIAS
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH = persistedWorkflow;
    process.env.MY_ALIAS = aliasedControlPath;
    try {
      assert.throws(() => createCodexAgent(), /credential MY_ALIAS resolves inside controller-only execution state/u);
    } finally {
      if (previous.config === undefined) delete process.env.ULTRAFUZZ_CONFIG_PATH;
      else process.env.ULTRAFUZZ_CONFIG_PATH = previous.config;
      if (previous.workflow === undefined) delete process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH;
      else process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH = previous.workflow;
      if (previous.alias === undefined) delete process.env.MY_ALIAS;
      else process.env.MY_ALIAS = previous.alias;
    }
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

    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 999,
        reasoning_tokens: 20
      }
    });
    const events = agent.createOutputInterpreter().onStdoutLine?.(resultLine) as Array<{
      type?: string;
      usage?: Record<string, number>;
    }>;
    const completed = events.find((event) => event.type === "completed");
    assert.deepEqual(completed?.usage, {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 0,
      total_tokens: 550
    });
  }
);

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
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: 524
    };

    const successful = new DeepSeekClaudeCodeAgent({ model: "deepseek-v4-pro", ultrafuzzApiKey: "test-key" });
    successful.buildCommand = async () => ({
      command: process.execPath,
      args: [
        "-e",
        `console.log(${JSON.stringify(
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
            session_id: "deepseek-session",
            usage: providerUsage
          })
        )})`
      ],
      outputFormat: "stream-json"
    });
    const result = await successful.generate({ prompt: "Telemetry", rootDir: project });
    assert.deepEqual(result.usage, normalizedUsage);

    const streamed = await successful.stream({ prompt: "Stream telemetry", rootDir: project });
    assert.deepEqual(await streamed.usage, normalizedUsage);
    assert.deepEqual(await streamed.totalUsage, normalizedUsage);

    const failed = new DeepSeekClaudeCodeAgent({ model: "deepseek-v4-pro", ultrafuzzApiKey: "test-key" });
    failed.buildCommand = async () => ({
      command: process.execPath,
      args: [
        "-e",
        `console.log(${JSON.stringify(
          JSON.stringify({
            type: "result",
            subtype: "error",
            is_error: true,
            error: "provider failed",
            usage: providerUsage
          })
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
  }
);

test(
  "generated Pi adapter binds OpenRouter through env and keeps the credential out of argv",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { createPiAgent } = await loadGeneratedPiAgent(project);
    const configPath = path.join(project, "ultrafuzz.toml");
    const stockConfig = fs.readFileSync(configPath, "utf8");
    const credential = "sk-or-v1-not-a-real-openrouter-credential";
    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      openRouter: process.env.OPENROUTER_API_KEY,
      named: process.env.PI_OPENROUTER_KEY
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.OPENROUTER_API_KEY = credential;
    delete process.env.PI_OPENROUTER_KEY;
    try {
      const configDir = path.resolve(process.cwd(), ".ultrafuzz/pi-coding-agent");
      const agent = createPiAgent({ model: "openai/gpt-mini-latest", addDir: ["/tmp/artifacts"] });
      const command = await agent.buildCommand({ prompt: "find a bug", cwd: project, options: {} });

      // The complete OpenRouter binding is `--provider openrouter` plus an
      // opaque catalogue id; pi owns the endpoint, so there is no base URL.
      assert.equal(command.command, "pi");
      assert.deepEqual(command.args, [
        "--print",
        "--provider",
        "openrouter",
        "--model",
        "openai/gpt-mini-latest",
        "--session-dir",
        path.join(configDir, "sessions"),
        "find a bug"
      ]);

      // The acceptance criterion: no credential value anywhere in argv, and no
      // `--api-key` flag, because the adapter never sets Smithers' `apiKey`.
      assert.equal(command.args.includes("--api-key"), false);
      assert.equal(
        command.args.some((argument) => argument.includes(credential)),
        false
      );
      assert.equal((agent.opts as { apiKey?: string }).apiKey, undefined);

      // The credential reaches the child only through the environment, and that
      // environment went through workflowControlChildEnvironment: every
      // controller-only variable is blanked in both layers Smithers composes.
      const childEnv = { ...process.env, ...agent.opts.env, ...command.env };
      assert.equal(childEnv.OPENROUTER_API_KEY, credential);
      assert.equal(agent.opts.env.ULTRAFUZZ_CONFIG_PATH, "");
      assert.equal(command.env?.ULTRAFUZZ_CONFIG_PATH, "");
      assert.equal(childEnv.ULTRAFUZZ_CONFIG_PATH, "");

      // Isolation: pi's config directory and session storage stay off the
      // operator's real home (~/.pi/agent), and install telemetry is off.
      assert.equal(agent.opts.env.PI_CODING_AGENT_DIR, configDir);
      assert.equal(agent.opts.sessionDir, path.join(configDir, "sessions"));
      assert.equal(agent.opts.env.PI_TELEMETRY, "0");
      assert.equal(agent.opts.env.PI_CODING_AGENT_SESSION_DIR, undefined);

      // Profile reasoning maps onto pi's existing --thinking level.
      const thinkingAgent = createPiAgent({ model: "openai/gpt-mini-latest", reasoningEffort: "high" });
      const thinkingCommand = await thinkingAgent.buildCommand({ prompt: "x", cwd: project, options: {} });
      const thinkingIndex = thinkingCommand.args.indexOf("--thinking");
      assert.notEqual(thinkingIndex, -1);
      assert.equal(thinkingCommand.args[thinkingIndex + 1], "high");
      // The throw must name the file and the key, not just the range: this is the
      // error an operator hits copying `reasoning = "max"` off another profile.
      assert.throws(
        () => createPiAgent({ reasoningEffort: "ludicrous" }),
        /models\.<profile>\.reasoning in .*ultrafuzz\.toml is ludicrous, which PiAgent does not support; use one of off, minimal, low, medium, high, xhigh/u
      );

      // api_key_env names only where ultrafuzz reads the operator's value from;
      // pi always receives it as OPENROUTER_API_KEY, the name pi looks up.
      fs.writeFileSync(
        configPath,
        stockConfig.replace(
          /\[agents\.PiAgent\]\nauth = "api-key"\napi_key_env = "OPENROUTER_API_KEY"/u,
          '[agents.PiAgent]\nauth = "api-key"\napi_key_env = "PI_OPENROUTER_KEY"'
        ),
        "utf8"
      );
      process.env.PI_OPENROUTER_KEY = "sk-or-v1-named-variable-credential";
      const namedAgent = createPiAgent({ model: "openai/gpt-mini-latest" });
      assert.equal(namedAgent.opts.env.OPENROUTER_API_KEY, "sk-or-v1-named-variable-credential");
      assert.equal(namedAgent.opts.env.PI_OPENROUTER_KEY, undefined);

      // A missing credential fails loudly, naming the variable it wanted.
      delete process.env.PI_OPENROUTER_KEY;
      assert.throws(
        () => createPiAgent({ model: "openai/gpt-mini-latest" }),
        /agents\.PiAgent in .*ultrafuzz\.toml uses api-key auth, but PI_OPENROUTER_KEY is not set/u
      );

      // Subscription auth has no meaning for this adapter and is rejected.
      fs.writeFileSync(
        configPath,
        stockConfig.replace(
          /\[agents\.PiAgent\]\nauth = "api-key"\napi_key_env = "OPENROUTER_API_KEY"/u,
          '[agents.PiAgent]\nauth = "subscription"'
        ),
        "utf8"
      );
      assert.throws(
        () => createPiAgent({ model: "openai/gpt-mini-latest" }),
        /agents\.PiAgent in .*ultrafuzz\.toml supports only api-key auth, not subscription/u
      );
    } finally {
      fs.writeFileSync(configPath, stockConfig, "utf8");
      if (previous.config === undefined) delete process.env.ULTRAFUZZ_CONFIG_PATH;
      else process.env.ULTRAFUZZ_CONFIG_PATH = previous.config;
      if (previous.openRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous.openRouter;
      if (previous.named === undefined) delete process.env.PI_OPENROUTER_KEY;
      else process.env.PI_OPENROUTER_KEY = previous.named;
    }
  }
);

/**
 * Isolation for OpenCode is not implicit. `workflowControlChildEnvironment`
 * returns a delta layered over the inherited environment, so any state root the
 * adapter does not name by hand stays pointed at the operator's real home --
 * which is exactly how an earlier ten-seat run wrote OpenCode's config
 * directory, database, snapshots and downloaded binaries there.
 */
test(
  "generated OpenCode adapter scopes the harness state roots it names to the run and keeps the credential out of argv",
  // Bun's node:test shim ignores `skip` but honours `timeout`, and applies a
  // 5s default without one. `initProject` plus the transpile in
  // `loadGeneratedOpenCodeAgent` exceeds that on a cold cache.
  { skip: !runningUnderBun, timeout: 120_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const runRoot = path.join(project, ".ultrafuzz", "runs", "opencode-isolation");
    const artifactDir = path.join(runRoot, "artifacts", "recon");
    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      key: process.env.OPENROUTER_API_KEY
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = path.join(project, "ultrafuzz.toml");
    process.env.OPENROUTER_API_KEY = "opencode-test-key";
    try {
      const { createOpenCodeAgent } = await loadGeneratedOpenCodeAgent(project);
      const agent = createOpenCodeAgent({
        model: "openrouter/anthropic/claude-opus-4.8",
        reasoningEffort: "high",
        addDir: [artifactDir]
      });
      const stateRoot = path.join(runRoot, "opencode");
      assert.deepEqual(agent.opts.extraArgs, ["--pure"]);
      assert.equal(agent.opts.yolo, true);
      assert.equal(agent.opts.variant, "high");
      assert.equal(agent.opts.env.XDG_CONFIG_HOME, path.join(stateRoot, "config"));
      assert.equal(agent.opts.env.XDG_DATA_HOME, path.join(stateRoot, "data"));
      assert.equal(agent.opts.env.XDG_CACHE_HOME, path.join(stateRoot, "cache"));
      assert.equal(agent.opts.env.XDG_STATE_HOME, path.join(stateRoot, "state"));
      assert.equal(agent.opts.env.XDG_RUNTIME_DIR, path.join(stateRoot, "runtime"));
      assert.equal(agent.opts.env.OPENCODE_CONFIG_DIR, path.join(stateRoot, "config", "opencode"));
      // npm ignores the XDG base directories and falls back to ~/.npm, so this closes a
      // real leak; bun already resolves under XDG_CACHE_HOME, so this only pins the path.
      assert.equal(agent.opts.env.npm_config_cache, path.join(stateRoot, "cache", "npm"));
      assert.equal(agent.opts.env.BUN_INSTALL_CACHE_DIR, path.join(stateRoot, "cache", "bun"));
      // OPENCODE_DB is resolved ahead of XDG_DATA_HOME and wins, so naming the
      // XDG roots alone leaves the database inheritable.
      assert.equal(agent.opts.env.OPENCODE_DB, path.join(stateRoot, "data", "opencode", "opencode.db"));
      // Every remaining single-file override names a file outside the run when
      // inherited, so each is blanked rather than left to the parent.
      for (const name of [
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_MODELS_PATH",
        "OPENCODE_TUI_CONFIG",
        "OPENCODE_PLUGIN_META_FILE"
      ]) {
        assert.equal(agent.opts.env[name], "", `${name} was left inheritable`);
      }
      for (const name of [
        "OPENCODE_DISABLE_AUTOUPDATE",
        "OPENCODE_DISABLE_SHARE",
        "OPENCODE_DISABLE_MODELS_FETCH",
        "OPENCODE_DISABLE_DEFAULT_PLUGINS",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_LSP_DOWNLOAD"
      ]) {
        assert.equal(agent.opts.env[name], "1", `${name} was not suppressed`);
      }
      // No state root may resolve inside the operator's home.
      for (const name of [
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "XDG_RUNTIME_DIR",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_DB",
        "npm_config_cache",
        "BUN_INSTALL_CACHE_DIR"
      ]) {
        const value = agent.opts.env[name] ?? "";
        assert.equal(value.startsWith(runRoot), true, `${name} escaped the run root: ${value}`);
        assert.equal(
          path.relative(os.homedir(), value).startsWith(".."),
          true,
          `${name} resolves inside the operator home: ${value}`
        );
      }
      // The credential reaches the child environment and never the argv.
      assert.equal(agent.opts.env.OPENROUTER_API_KEY, "opencode-test-key");
      const command = await agent.buildCommand({ prompt: "Contract only", cwd: project, options: {} });
      assert.equal(command.command, "opencode");
      assert.equal(command.args.includes("--pure"), true);
      assert.equal(
        command.args.some((argument) => argument.includes("opencode-test-key")),
        false,
        "credential leaked into the OpenCode argv"
      );
      // The subclass override is the only one: everything else -- argv, prompt
      // assembly, output interpretation, usage, sessions -- stays with Smithers.
      assert.equal(command.args.includes("-m"), true);
      assert.equal(command.args.includes("openrouter/anthropic/claude-opus-4.8"), true);
      // Controller-only capabilities are withheld, proving the command env went
      // through workflowControlChildEnvironment.
      for (const name of [
        "ULTRAFUZZ_CONFIG_PATH",
        "ULTRAFUZZ_RUNTIME_MODULE",
        "ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT",
        "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH",
        "SMITHERS_BIN"
      ]) {
        assert.equal(command.env?.[name], "", `${name} escaped into the OpenCode child environment`);
      }

      // Without an artifact directory the state root still stays project-local.
      const bare = createOpenCodeAgent({ model: "openrouter/anthropic/claude-opus-4.8" });
      assert.equal(bare.opts.env.XDG_CONFIG_HOME, path.join(process.cwd(), ".ultrafuzz", "opencode", "config"));

      delete process.env.OPENROUTER_API_KEY;
      assert.throws(
        () => createOpenCodeAgent({ addDir: [artifactDir] }),
        /agents\.OpenCodeAgent auth is api-key, but OPENROUTER_API_KEY is not set/u
      );
    } finally {
      if (previous.config === undefined) delete process.env.ULTRAFUZZ_CONFIG_PATH;
      else process.env.ULTRAFUZZ_CONFIG_PATH = previous.config;
      if (previous.key === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous.key;
    }
  }
);

/**
 * `auth = "subscription"` cannot work here and must not be accepted quietly.
 * OpenCode reads auth.json from `$XDG_DATA_HOME/opencode`, and this adapter
 * always relocates XDG_DATA_HOME into the run, so a subscription login the
 * operator holds is unreachable by construction; accepting the value would hand
 * the workflow an agent that is silently unauthenticated.
 */
test(
  "generated OpenCode adapter rejects subscription auth instead of running unauthenticated",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const subscriptionConfig = path.join(project, "opencode-subscription.toml");
    fs.writeFileSync(subscriptionConfig, '[agents.OpenCodeAgent]\nauth = "subscription"\n', "utf8");
    const previous = { config: process.env.ULTRAFUZZ_CONFIG_PATH, key: process.env.OPENROUTER_API_KEY };
    process.env.ULTRAFUZZ_CONFIG_PATH = path.join(project, "ultrafuzz.toml");
    process.env.OPENROUTER_API_KEY = "opencode-test-key";
    try {
      const { createOpenCodeAgent } = await loadGeneratedOpenCodeAgent(project);
      // The shipped api-key config still builds an agent.
      assert.equal(typeof createOpenCodeAgent({ model: "openrouter/anthropic/claude-opus-4.8" }), "object");
      process.env.ULTRAFUZZ_CONFIG_PATH = subscriptionConfig;
      assert.throws(
        () => createOpenCodeAgent({ model: "openrouter/anthropic/claude-opus-4.8" }),
        /agents\.OpenCodeAgent\.auth must be api-key in ultrafuzz\.toml, not subscription/u
      );
    } finally {
      if (previous.config === undefined) delete process.env.ULTRAFUZZ_CONFIG_PATH;
      else process.env.ULTRAFUZZ_CONFIG_PATH = previous.config;
      if (previous.key === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous.key;
    }
  }
);

/**
 * OpenCodeAgent grants blanket tool approval by setting OPENCODE_PERMISSION from
 * its own `buildCommand`. The scrub must merge over that value: replacing it
 * would silently restore permission prompts nobody is there to answer.
 */
test(
  "generated OpenCode adapter preserves the agent's own yolo permission env through the scrub",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const previous = { config: process.env.ULTRAFUZZ_CONFIG_PATH, key: process.env.OPENROUTER_API_KEY };
    process.env.ULTRAFUZZ_CONFIG_PATH = path.join(project, "ultrafuzz.toml");
    process.env.OPENROUTER_API_KEY = "opencode-test-key";
    try {
      const { createOpenCodeAgent } = await loadGeneratedOpenCodeAgent(project);
      const agent = createOpenCodeAgent({ model: "openrouter/anthropic/claude-opus-4.8" });
      const command = await agent.buildCommand({ prompt: "Contract only", cwd: project, options: {} });
      assert.equal(command.env?.OPENCODE_PERMISSION, '{"*":"allow"}');
    } finally {
      if (previous.config === undefined) delete process.env.ULTRAFUZZ_CONFIG_PATH;
      else process.env.ULTRAFUZZ_CONFIG_PATH = previous.config;
      if (previous.key === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous.key;
    }
  }
);

/**
 * The filesystem proof, run as a matched pair against the real OpenCode CLI.
 *
 * The positive arm runs the adapter's environment and asserts nothing lands in
 * OpenCode's per-user locations, and that an inherited absolute `OPENCODE_DB` --
 * which OpenCode resolves ahead of XDG_DATA_HOME and honours outright -- does
 * not survive. The negative control runs the SAME argv with that environment
 * removed and asserts the leak does happen, so a green positive arm cannot be
 * an artefact of the CLI writing nothing at all.
 *
 * Where the CLI is absent the case is declared skipped, not returned from: a
 * body that returns early reports as a pass and would let a machine without
 * OpenCode installed claim a proof it never ran. The selector below is what
 * declares it -- Bun's `node:test` shim, which is what runs this file, ignores
 * the `skip` option but does honour `test.skip`.
 */
const openCodeCliInstalled = runningUnderBun && spawnSync("opencode", ["--version"], { encoding: "utf8" }).status === 0;
const openCodeFilesystemProof = openCodeCliInstalled ? test : test.skip;
openCodeFilesystemProof(
  "generated OpenCode adapter writes none of the named harness state roots under a redirected home",
  { timeout: 180_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-opencode-home-"));
    const leakHome = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-opencode-leak-"));
    const inheritedDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ufz-opencode-db-")), "inherited.db");
    const runRoot = path.join(project, ".ultrafuzz", "runs", "opencode-home");
    const artifactDir = path.join(runRoot, "artifacts", "recon");
    const previous = { config: process.env.ULTRAFUZZ_CONFIG_PATH, key: process.env.OPENROUTER_API_KEY };
    process.env.ULTRAFUZZ_CONFIG_PATH = path.join(project, "ultrafuzz.toml");
    process.env.OPENROUTER_API_KEY = "opencode-invalid-test-key";
    try {
      const { createOpenCodeAgent } = await loadGeneratedOpenCodeAgent(project);
      const agent = createOpenCodeAgent({
        model: "openrouter/anthropic/claude-opus-4.8",
        addDir: [artifactDir]
      });
      const command = await agent.buildCommand({
        prompt: "Reply with exactly fixture-ok and do not use tools.",
        cwd: project,
        options: {}
      });
      // Both arms start from an operator environment that already points
      // OPENCODE_DB somewhere the run does not own.
      const inherited: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined) inherited[name] = value;
      }
      inherited.OPENCODE_DB = inheritedDb;

      spawnSync(command.command, command.args, {
        cwd: project,
        encoding: "utf8",
        env: { ...inherited, HOME: home, ...agent.opts.env, ...command.env },
        timeout: 60_000
      });
      // Every default per-user location OpenCode would otherwise populate.
      // `.npm` is deliberately not in this list. OpenCode spawns npm only while
      // resolving a provider SDK, and this invocation sometimes exits on the
      // auth failure before that subprocess creates its cache -- the run-scoped
      // npm cache appeared in 2 of 3 sampled runs here. An assertion that flips
      // on that race would pass whether or not the adapter still sets
      // npm_config_cache, so it is pinned deterministically instead by
      // "generated OpenCode adapter redirects the npm and bun caches" below.
      for (const relative of [
        [".config", "opencode"],
        [".local", "share", "opencode"],
        [".local", "state", "opencode"],
        [".cache", "opencode"]
      ]) {
        const leaked = path.join(home, ...relative);
        assert.equal(fs.existsSync(leaked), false, `OpenCode wrote harness state to ${leaked}`);
      }
      assert.equal(fs.existsSync(inheritedDb), false, `an inherited OPENCODE_DB survived into ${inheritedDb}`);
      assert.equal(fs.existsSync(path.join(runRoot, "opencode")), true, "no run-scoped OpenCode state root was used");
      assert.equal(
        fs.existsSync(path.join(runRoot, "opencode", "data", "opencode", "opencode.db")),
        true,
        "the OpenCode database was not created inside the run-scoped state root"
      );

      // Negative control: the same argv with the adapter's environment removed.
      const leaking: Record<string, string> = { ...inherited, HOME: leakHome };
      for (const name of Object.keys(agent.opts.env)) {
        if (name !== "OPENROUTER_API_KEY") delete leaking[name];
      }
      leaking.OPENCODE_DB = inheritedDb;
      leaking.OPENCODE_PERMISSION = '{"*":"allow"}';
      spawnSync(command.command, command.args, {
        cwd: project,
        encoding: "utf8",
        env: leaking,
        timeout: 60_000
      });
      assert.equal(
        fs.existsSync(inheritedDb),
        true,
        "negative control did not reproduce the inherited-OPENCODE_DB leak, so the positive arm proves nothing"
      );
      assert.equal(
        fs.existsSync(path.join(leakHome, ".config", "opencode")),
        true,
        "negative control did not reproduce the per-user config leak, so the positive arm proves nothing"
      );
    } finally {
      if (previous.config === undefined) delete process.env.ULTRAFUZZ_CONFIG_PATH;
      else process.env.ULTRAFUZZ_CONFIG_PATH = previous.config;
      if (previous.key === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous.key;
      fs.rmSync(home, { force: true, recursive: true });
      fs.rmSync(leakHome, { force: true, recursive: true });
      fs.rmSync(path.dirname(inheritedDb), { force: true, recursive: true });
    }
  }
);

/**
 * `npm_config_cache` and `BUN_INSTALL_CACHE_DIR` are the two roots the adapter
 * names that belong to tools other than OpenCode, and the OpenCode proof above
 * cannot pin them: whether OpenCode's npm subprocess outlives the auth failure
 * is a race, so an assertion there passes with or without the variable set.
 * This arm drives npm and bun directly under the adapter's own environment,
 * where the outcome is deterministic -- deleting either line from the template
 * failed this test in 2 of 2 sampled runs each.
 *
 * The two variables do different work, and the assertions say so rather than
 * treating them alike. npm ignores the XDG base directories, so dropping
 * `npm_config_cache` puts `_cacache` straight into `$HOME/.npm` -- a real leak,
 * checked here as a matched pair. bun resolves its cache under
 * `XDG_CACHE_HOME`, which the adapter already redirects, so dropping
 * `BUN_INSTALL_CACHE_DIR` moves the directory but cannot reach the operator's
 * home; the control asserts exactly that weaker property.
 */
const npmCliInstalled = runningUnderBun && spawnSync("npm", ["--version"], { encoding: "utf8" }).status === 0;
const openCodePackageCacheProof = npmCliInstalled ? test : test.skip;
openCodePackageCacheProof(
  "generated OpenCode adapter redirects the npm and bun caches out of the operator home",
  { timeout: 120_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-opencode-pkg-"));
    const leakHome = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-opencode-pkg-leak-"));
    const runRoot = path.join(project, ".ultrafuzz", "runs", "opencode-package-cache");
    const artifactDir = path.join(runRoot, "artifacts", "recon");
    const previous = { config: process.env.ULTRAFUZZ_CONFIG_PATH, key: process.env.OPENROUTER_API_KEY };
    process.env.ULTRAFUZZ_CONFIG_PATH = path.join(project, "ultrafuzz.toml");
    process.env.OPENROUTER_API_KEY = "opencode-invalid-test-key";
    try {
      const { createOpenCodeAgent } = await loadGeneratedOpenCodeAgent(project);
      const agent = createOpenCodeAgent({
        model: "openrouter/anthropic/claude-opus-4.8",
        addDir: [artifactDir]
      });
      const stateRoot = path.join(runRoot, "opencode");
      const inherited: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined) inherited[name] = value;
      }
      const isolated = { ...inherited, HOME: home, ...agent.opts.env };
      // `npm cache verify` creates and reports the cache directory and needs no
      // registry; `bun pm cache` prints the directory bun would install into.
      // bun >= 1.3.14 refuses to run `pm cache` in a directory with no
      // package.json, so give it a minimal one -- the scaffold does not ship one.
      const projectManifest = path.join(project, "package.json");
      if (!fs.existsSync(projectManifest)) {
        fs.writeFileSync(projectManifest, JSON.stringify({ name: "ufz-cache-probe", private: true }), "utf8");
      }
      const npmIsolated = spawnSync("npm", ["cache", "verify"], {
        cwd: project,
        encoding: "utf8",
        env: isolated,
        timeout: 60_000
      });
      assert.equal(npmIsolated.status, 0, `npm cache verify failed: ${npmIsolated.stderr}`);
      assert.equal(
        fs.existsSync(path.join(stateRoot, "cache", "npm", "_cacache")),
        true,
        "the npm cache was not redirected into the run-scoped state root"
      );
      assert.equal(fs.existsSync(path.join(home, ".npm")), false, "npm wrote its cache into the operator home");
      const bunIsolated = spawnSync("bun", ["pm", "cache"], {
        cwd: project,
        encoding: "utf8",
        env: isolated,
        timeout: 60_000
      });
      assert.equal(bunIsolated.status, 0, `bun pm cache failed: ${bunIsolated.stderr}`);
      assert.equal(bunIsolated.stdout.trim(), path.join(stateRoot, "cache", "bun"));

      // Control: the same commands with only those two variables dropped.
      const leaking: Record<string, string> = { ...inherited, HOME: leakHome, ...agent.opts.env };
      delete leaking.npm_config_cache;
      delete leaking.BUN_INSTALL_CACHE_DIR;
      const npmLeak = spawnSync("npm", ["cache", "verify"], {
        cwd: project,
        encoding: "utf8",
        env: leaking,
        timeout: 60_000
      });
      assert.equal(npmLeak.status, 0, `npm cache verify failed: ${npmLeak.stderr}`);
      assert.equal(
        fs.existsSync(path.join(leakHome, ".npm", "_cacache")),
        true,
        "dropping npm_config_cache did not put the npm cache in the operator home, so the positive arm proves nothing"
      );
      const bunLeak = spawnSync("bun", ["pm", "cache"], {
        cwd: project,
        encoding: "utf8",
        env: leaking,
        timeout: 60_000
      });
      assert.equal(bunLeak.status, 0, `bun pm cache failed: ${bunLeak.stderr}`);
      // Weaker on purpose: without BUN_INSTALL_CACHE_DIR the path still lands
      // under the redirected XDG_CACHE_HOME, so the variable pins the location
      // rather than closing a leak. It moves, and it stays out of the home.
      assert.notEqual(bunLeak.stdout.trim(), path.join(stateRoot, "cache", "bun"));
      assert.equal(
        path.relative(stateRoot, bunLeak.stdout.trim()).startsWith(".."),
        false,
        `bun resolved its cache outside the run-scoped state root: ${bunLeak.stdout.trim()}`
      );
      assert.equal(fs.existsSync(path.join(leakHome, ".bun")), false, "bun wrote its cache into the operator home");
    } finally {
      if (previous.config === undefined) delete process.env.ULTRAFUZZ_CONFIG_PATH;
      else process.env.ULTRAFUZZ_CONFIG_PATH = previous.config;
      if (previous.key === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous.key;
      fs.rmSync(home, { force: true, recursive: true });
      fs.rmSync(leakHome, { force: true, recursive: true });
    }
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

type Utf8SpawnSync = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding
) => SpawnSyncReturns<string>;

function spawnKimiSurfaceProbe(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
  runner: Utf8SpawnSync = spawnSync
): SpawnSyncReturns<string> {
  let result = runner(command, args, options);
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EAGAIN" || code === "ETIMEDOUT") result = runner(command, args, options);
  return result;
}

test("Kimi surface probes retry one transient spawn failure", () => {
  let calls = 0;
  const transient = Object.assign(new Error("cold runner timed out"), { code: "ETIMEDOUT" });
  const result = spawnKimiSurfaceProbe("/fixture/kimi", ["--version"], { encoding: "utf8", timeout: 15_000 }, () => {
    calls += 1;
    const error = calls === 1 ? transient : undefined;
    return {
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: error === undefined ? 2 : null,
      signal: null,
      ...(error === undefined ? {} : { error })
    };
  });
  assert.equal(calls, 2);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
});

test(
  "generated Kimi API config and argv match the real Kimi Code 0.29.1 surface",
  { skip: !runningUnderBun || !fs.existsSync(localKimiCode), timeout: 60_000 },
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
    process.env.KIMI_BASE_URL = "https://127.0.0.1:9/v1";
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
    }
    assert.ok(command.env?.KIMI_CODE_HOME);
    execFileSync(localKimiCode, ["doctor", "config", path.join(command.env.KIMI_CODE_HOME, "config.toml")], {
      encoding: "utf8"
    });
    const parserArgs = [...command.args];
    const modelIndex = parserArgs.indexOf("--model");
    assert.notEqual(modelIndex, -1);
    parserArgs[modelIndex + 1] = "missing-model-for-contract";
    const parsed = spawnKimiSurfaceProbe(localKimiCode, parserArgs, {
      cwd: project,
      env: {
        ...process.env,
        KIMI_CODE_HOME: command.env.KIMI_CODE_HOME,
        KIMI_SHARE_DIR: command.env.KIMI_CODE_HOME,
        NO_PROXY: "127.0.0.1,localhost"
      },
      encoding: "utf8",
      timeout: 15_000
    });
    assert.equal(
      parsed.error,
      undefined,
      `Kimi Code surface probe did not start after one transient retry: ${(parsed.error as NodeJS.ErrnoException | undefined)?.code ?? parsed.error?.message}`
    );
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
  { skip: !runningUnderBun || !fs.existsSync(localKimiCode), timeout: 60_000 },
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
      const parsed = spawnKimiSurfaceProbe(
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
          timeout: 15_000
        }
      );
      assert.equal(
        parsed.error,
        undefined,
        `Kimi Code authentication probe did not start after one transient retry: ${(parsed.error as NodeJS.ErrnoException | undefined)?.code ?? parsed.error?.message}`
      );
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
  const renderedPromptPath = path.join(plan.value!.run_root, "artifacts/project-discovery/prompt.rendered.md");
  assert.equal(fs.existsSync(renderedPromptPath), true);
  const renderedPrompt = fs.readFileSync(renderedPromptPath, "utf8");
  assert.match(renderedPrompt, /severity_guess to exactly "High", "Medium", or "Low"/u);
  assert.match(renderedPrompt, /including one that is or may become a non-production record/u);
  assert.match(renderedPrompt, /"severity_guess":"Medium"/u);
  assert.doesNotMatch(renderedPrompt, /"severity_guess":"medium"/u);
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

test("planned graphs persist topology overrides and effective per-model timeouts", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const plan = await planRun({ projectRoot: project, runId: "planned-timeout", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const plannedNode = plan.value!.graph.nodes.find((node) => node.id === "project-discovery");
  assert.equal(plannedNode?.timeout_seconds, undefined);
  assert.equal(plannedNode?.model_fanout[0]?.timeout_seconds, plan.value!.resolved_config.run.defaultTimeoutSeconds);
  assert.equal(plannedNode?.model_fanout[0]?.attempt_id, "project-discovery");
  const expandedNode = plan.value!.expanded_graph.nodes.find((node) => node.id === "project-discovery");
  assert.notEqual(expandedNode, undefined);
  expandedNode!.timeoutSeconds = 7200;

  const graph = toPlannedGraph(plan.value!.expanded_graph);
  assert.equal(graph.nodes.find((node) => node.id === "project-discovery")?.timeout_seconds, 7200);
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
  assert.equal(plan.value!.validation.topology?.path, "smoke-benchmark.yml");
  assert.deepEqual(
    plan.value!.graph.nodes.map((node) => node.logical_id),
    ["project-discovery"]
  );
  assert.equal(fs.readFileSync(canonicalTopology, "utf8"), "not: [valid\n");
});

test("a clean scaffold pins the reviewed vulnerability database verbatim", () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);

  // The scaffolded catalog is the shipped catalog, byte for byte: no test mutates it into passing.
  const scaffoldedYaml = fs.readFileSync(path.join(project, ".ultrafuzz", "references.yml"), "utf8");
  assert.deepEqual(parseReferenceCatalog(scaffoldedYaml), shippedReferenceCatalog());

  const pinned = loadReferenceCatalog(project).references["vulnerability-database.web3"];
  assert.ok(pinned, "the shipped scaffold must define vulnerability-database.web3");
  assert.equal(pinned.kind, "vulnerability-database");
  assert.equal(pinned.provider, "github");
  assert.equal(pinned.repo, "aviggiano/web3-vulnerability-database");
  assert.equal(pinned.commit, "74c2a5114b7adbd208eb49e47c137daa49b4a395");
  assert.deepEqual([...pinned.paths], ["database.yml", "capabilities.yml", "catalog.json"]);
  assert.equal(pinned.resolved_at, "2026-08-09T01:15:37Z");
});

test("a clean scaffold publishes the canonical artifact schema files the prompts reference", () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);

  for (const [relativePath, schema, id] of [
    [".ultrafuzz/schema/threat-model.schema.json", threatModelJsonSchema, THREAT_MODEL_JSON_SCHEMA_ID],
    [".ultrafuzz/schema/goal-plan.schema.json", goalPlanJsonSchema, GOAL_PLAN_JSON_SCHEMA_ID]
  ] as const) {
    const filePath = path.join(project, ...relativePath.split("/"));
    assert.equal(fs.statSync(filePath).isFile(), true, `${relativePath} must exist in a clean scaffold`);
    fs.accessSync(filePath, fs.constants.R_OK);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    // Generated from the one runtime validator, so the file an agent reads and the gate it must
    // pass can never disagree.
    assert.deepEqual(parsed, schema);
    assert.equal(parsed.$id, id);
    // The published bytes are the digest-stable canonical form.
    assert.equal(
      crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
      crypto.createHash("sha256").update(projectArtifactSchemaJson(schema)).digest("hex")
    );
  }

  // Every prompt names its canonical schema through the rendered `artifact_schema_dir` variable,
  // so the agent resolves an absolute path rather than a literal that only works from the project
  // root. Each referenced file must be one the scaffold actually publishes.
  const promptRoot = path.join(project, ".ultrafuzz", "prompts");
  const referenced = new Set<string>();
  for (const promptPath of listFilesRecursively(promptRoot)) {
    const body = fs.readFileSync(promptPath, "utf8");
    assert.equal(
      /`\.ultrafuzz\/schema\//u.test(body),
      false,
      `${promptPath} must not hardcode a project-relative schema path`
    );
    for (const match of body.matchAll(/\{\{artifact_schema_dir\}\}\/([A-Za-z0-9._-]+\.schema\.json)/gu)) {
      referenced.add(match[1]!);
    }
  }
  assert.deepEqual([...referenced].sort(), ["goal-plan.schema.json", "threat-model.schema.json"]);
  for (const fileName of referenced) {
    const filePath = path.join(projectArtifactSchemaDir(project), fileName);
    assert.equal(fs.statSync(filePath).isFile(), true, fileName);
    fs.accessSync(filePath, fs.constants.R_OK);
  }
});

test("a clean scaffold caps goal replacement values instead of only asking the planner to keep them short", () => {
  // Regression guard for the measured #672/#677 cause. The goal-plan `goal_prompt` template is a
  // ~161-character sentence whose namespaced MDX placeholders are substituted from `replacements`,
  // and `goal-hunter.mdx` tells the hunter that sentence is its authoritative focused goal. In one
  // 18-hour local default-profile run the planner inlined whole records there -- a full
  // vulnerability-class record plus a full threat-model entry with its `attack_surfaces`, `assets`,
  // `actors`, and every `evidence` array -- giving a per-goal replacement payload of min 3,751 /
  // median 13,956 / max 42,483 characters across 88 goals. Every goal node therefore opened with a
  // multi-thousand-token JSON wall, 9 nodes were killed at exactly their 7200000ms timeout, and only
  // 3 of 77 class-goal nodes produced any output.
  //
  // The prompt that mandated the inlining has been rewritten, but a prompt is advice. This test
  // asserts the MECHANICAL half of the fix, in the two artifacts the planner agent is actually
  // handed by a clean scaffold: the canonical schema it is told to validate against, and the prompt
  // it is told to follow. Prompt-only enforcement of a token-budget invariant is exactly what
  // regressed here, so the cap has to be in the published contract bytes.
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);

  const schemaPath = path.join(projectArtifactSchemaDir(project), "goal-plan.schema.json");
  const published = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
    properties: Record<
      string,
      { items: { properties: { replacements: { additionalProperties: { anyOf: unknown[] } } } } }
    >;
  };
  for (const goalKind of ["threat_goals", "class_goals"] as const) {
    const branches = published.properties[goalKind]?.items.properties.replacements.additionalProperties.anyOf as
      Array<{ type?: string; minLength?: number; maxLength?: number }> | undefined;
    assert.ok(branches, `${goalKind} must publish a replacements value contract`);
    const stringBranch = branches.find((branch) => branch.type === "string");
    assert.ok(stringBranch, `${goalKind} replacements must accept a string label`);
    // A short label, and bounded. The bound is the load-bearing part: without it the contract admits
    // a record of any size, and the only thing standing between the planner and a JSON wall is prose.
    assert.equal(stringBranch.minLength, 1, `${goalKind} replacements must reject an empty label`);
    assert.equal(
      typeof stringBranch.maxLength,
      "number",
      `${goalKind} replacements must cap the label length; an uncapped value is how a whole record reached the goal sentence`
    );
    assert.ok(
      stringBranch.maxLength! <= 200,
      `${goalKind} replacements cap is ${String(stringBranch.maxLength)}, which is wide enough to inline a record`
    );
    // The smallest replacement payload measured in the failing run was 3,751 characters, so the cap
    // has to sit far below that rather than merely below the median.
    assert.ok(
      stringBranch.maxLength! < 3_751,
      `${goalKind} replacements cap is ${String(stringBranch.maxLength)}, which still admits the smallest inlined record measured`
    );
  }

  // And the prompt must no longer ask for the thing the contract now rejects, or every plan attempt
  // burns a retry producing a document the gate refuses.
  const planner = fs.readFileSync(path.join(project, ".ultrafuzz", "prompts", "setup", "goal-plan.md"), "utf8");
  assert.match(planner, /short human-readable label/u);
  assert.doesNotMatch(planner, /full contextual value/u);
  assert.doesNotMatch(planner, /contains the full selected threat/u);
  assert.doesNotMatch(planner, /focused hunter instructions and relevant examples/u);
});

function listFilesRecursively(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? listFilesRecursively(path.join(root, entry.name)) : [path.join(root, entry.name)]
    );
}

test("the shipped default topology expands against the shipped reference catalog", async () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);

  const shipped = await validateProject({ projectRoot: project, env: {} });
  assert.equal(shipped.ok, true, JSON.stringify(shipped.diagnostics));
  assert.ok((shipped.value!.topology?.expanded_nodes ?? 0) > 0);
});

test("a clean scaffold plans the threat-model, goal-plan, and dynamic fanout nodes", async () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  // Populate the normal reference cache with a valid local representation of every shipped pinned
  // reference. The shipped catalog itself is untouched, so this only removes network dependence.
  const xdgCacheHome = path.join(project, "xdg-cache");
  writeShippedDocumentReferenceCaches(xdgCacheHome, loadReferenceCatalog(project));
  writeShippedVulnerabilityDatabaseCache(xdgCacheHome);

  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = xdgCacheHome;
  let plan;
  try {
    const validation = await validateProject({ projectRoot: project, env: {} });
    assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));
    plan = await planRun({ projectRoot: project, runId: "clean-scaffold", env: {} });
  } finally {
    if (previousXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = previousXdgCacheHome;
    }
  }

  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const logicalIds = new Set(plan.value!.graph.nodes.map((node) => node.logical_id));
  for (const required of [
    "reference-vulnerability-database",
    "threat-model",
    "goal-plan",
    "goal-roaming",
    "threat-goals",
    "class-goals",
    "dedupe-findings",
    "final-report"
  ]) {
    assert.equal(logicalIds.has(required), true, `${required} must be planned by a clean scaffold`);
  }
  // The dynamic goal groups stay dynamic declarations rather than being silently flattened away.
  const dynamicIds = plan
    .value!.graph.nodes.filter((node) => node.dynamic !== undefined)
    .map((node) => node.logical_id)
    .sort();
  assert.deepEqual(dynamicIds, ["class-goals", "threat-goals"]);

  // The digest-bound planner catalog is materialized under the run root for the compiled tasks.
  const catalogPath = path.join(plan.value!.run_root, "vulnerability-db", "catalog.json");
  assert.equal(fs.existsSync(catalogPath), true);
  assert.equal(plan.value!.vulnerability_database?.relative_path, "vulnerability-db/catalog.json");
  assert.equal(
    plan.value!.vulnerability_database?.sha256,
    crypto.createHash("sha256").update(fs.readFileSync(catalogPath)).digest("hex")
  );

  // The threat-model and goal-plan prompts must render an absolute, readable canonical schema path
  // rather than an unresolved placeholder or a literal that only resolves from the project root.
  for (const [logicalId, fileName] of [
    ["threat-model", "threat-model.schema.json"],
    ["goal-plan", "goal-plan.schema.json"]
  ] as const) {
    const renderedPath: string[] = plan
      .value!.rendered_prompts.filter((entry) => entry.logical_node_id === logicalId)
      .map((entry) => entry.rendered_prompt_path);
    assert.equal(renderedPath.length > 0, true, `${logicalId} must render a prompt`);
    const body = fs.readFileSync(renderedPath[0]!, "utf8");
    const expected = path.join(projectArtifactSchemaDir(project), fileName);
    assert.equal(body.includes(expected), true, `${logicalId} must reference ${expected}`);
    assert.equal(body.includes("{{artifact_schema_dir}}"), false);
    assert.equal(body.includes("unavailable/"), false);
    fs.accessSync(expected, fs.constants.R_OK);
  }
});

test("project and runtime topology paths override a profile topology atomically", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const projectOverride = path.join(project, ".ultrafuzz", "project-override.yml");
  const runtimeOverride = path.join(project, ".ultrafuzz", "runtime-override.yml");
  fs.copyFileSync(path.join(project, ".ultrafuzz", "topology.yml"), projectOverride);
  fs.copyFileSync(projectOverride, runtimeOverride);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace(
        'audit_profile = "default"',
        'audit_profile = "smoke"\ntopology_path = ".ultrafuzz/project-override.yml"'
      ),
    "utf8"
  );
  fs.writeFileSync(path.join(project, ".ultrafuzz", "topology.yml"), "not: [valid\n", "utf8");

  const projectSelected = await validateProject({ projectRoot: project, env: {} });
  assert.equal(projectSelected.ok, true, JSON.stringify(projectSelected.diagnostics));
  assert.equal(projectSelected.value!.topology?.origin, "project-config");
  assert.equal(projectSelected.value!.topology?.path, ".ultrafuzz/project-override.yml");

  const runtimeSelected = await validateProject({
    projectRoot: project,
    topologyPath: runtimeOverride,
    env: {}
  });
  assert.equal(runtimeSelected.ok, true, JSON.stringify(runtimeSelected.diagnostics));
  assert.equal(runtimeSelected.value!.topology?.origin, "runtime-override");
  assert.equal(runtimeSelected.value!.topology?.path, ".ultrafuzz/runtime-override.yml");
});

test("audit profile selects its packaged topology and records portable provenance", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs.readFileSync(configPath, "utf8").replace('audit_profile = "default"', 'audit_profile = "smoke"'),
    "utf8"
  );
  fs.writeFileSync(path.join(project, ".ultrafuzz", "topology.yml"), "not: [valid\n", "utf8");

  const plan = await planRun({ projectRoot: project, runId: "profile-smoke", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.value!.resolved_config.run.maxParallelNodes, 4);
  assert.equal(plan.value!.resolved_config.run.workflowDeadlineSeconds, 14_400);
  assert.equal(plan.value!.resolved_config.auditProfileResolution.overriddenSettings.length, 0);
  assert.deepEqual(
    plan.value!.graph.nodes.map((node) => node.logical_id),
    [
      "smoke-context",
      "time-warp-sequences",
      "external-dependency-boundaries",
      "externalized-state-accounting",
      "lifecycle-view-boundaries",
      "dedupe-findings",
      "final-report"
    ]
  );
  assert.equal(plan.value!.validation.topology?.path, "topologies/smoke.yml");
  assert.equal(plan.value!.validation.topology?.origin, "audit-profile");
  const metadata = JSON.parse(fs.readFileSync(path.join(plan.value!.run_root, "run.json"), "utf8")) as {
    prompt_digest: string;
    audit_profile: Record<string, unknown>;
  };
  assert.match(metadata.prompt_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(metadata.audit_profile, {
    requested: "smoke",
    effective: "smoke",
    catalog_schema_version: 2,
    catalog_digest: plan.value!.resolved_config.auditProfileResolution.catalogDigest,
    settings: plan.value!.resolved_config.auditProfileResolution.settings,
    effective_settings: plan.value!.resolved_config.auditProfileResolution.effectiveSettings,
    setting_origins: plan.value!.resolved_config.auditProfileResolution.settingOrigins,
    overridden_settings: [],
    declared_topology_path: "topologies/smoke.yml",
    effective_topology_path: "topologies/smoke.yml",
    topology_path_origin: "audit-profile",
    topology_overridden: false,
    topology_digest: plan.value!.validation.topology?.digest,
    prompt_digest: metadata.prompt_digest,
    expanded_graph_fingerprint: plan.value!.graph_fingerprint
  });
});

test("plan applies one smoke eval model profile to a normally initialized target", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });

  const plan = await planRun({
    projectRoot: project,
    runId: "smoke-topology-profiles",
    runtimeOverrides: {
      auditProfile: "smoke",
      models: {
        profiles: {
          default: { agent: "CodexAgent", model: "gpt-5.6-luna", reasoning: "high" }
        }
      }
    },
    env: {}
  });

  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const executable = plan.value!.graph.nodes.filter((node) => node.kind === "agentic");
  assert.equal(executable.length, 7);
  assert.ok(executable.every((node) => node.model_fanout[0]?.model_profile_id === "default"));
  assert.ok(executable.every((node) => node.model_fanout[0]?.reasoning_effort === "high"));
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
  assert.equal(compiled.pinnedSubmodules, undefined);
  assert.match(workflowSource, /"pinnedSubmodules": null/u);
  assert.match(workflowSource, /dependsOn=\{task\.dependsOn\}/);
  assert.match(workflowSource, /const taskOutput = z\.object\(\{/);
  assert.match(workflowSource, /summary: z\.string\(\)\.min\(1\)/);
  assert.match(workflowSource, /smithers-display-name: Ultrafuzz native-deps/);
  assert.doesNotMatch(workflowSource, /__ULTRAFUZZ_/);
  assert.doesNotMatch(workflowSource, /const layers =/);
  assert.doesNotMatch(workflowSource, /<Sequence\b/);
  assert.match(workflowSource, /<Parallel\b/);

  const smithersTasks = JSON.parse(fs.readFileSync(compiled.tasksPath, "utf8")) as {
    layers?: unknown;
    pinned_submodules?: unknown;
    tasks: Array<{ attemptId: string; dependencySmithersNodeIds: string[] }>;
  };
  assert.equal(smithersTasks.pinned_submodules, null);
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

  const discovery = compiled.tasks.find((task) => task.metadata.node.logicalNodeId === "project-discovery");
  assert.ok(discovery);
  assert.deepEqual(discovery.execution.resources, {
    cpu: 8,
    memoryMiB: 16384,
    timeoutSeconds: 1800
  });
  assert.deepEqual(discovery.execution.agentCredentialEnv, ["OPENAI_API_KEY"]);
  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  assert.match(workflowSource, /<Sandbox/);
  assert.match(workflowSource, /createModalNodeSandboxProvider/);
  assert.match(workflowSource, /schema_version: "ultrafuzz\.modal\.node\.v1"/);
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
  assert.deepEqual(discovery.execution.agentCredentialEnv, ["KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_BASE_URL"]);
});

test("compileSmithersWorkflow escapes the evidence workflow import", async () => {
  const parent = tempProject();
  const project = path.join(parent, 'checkout"quoted');
  fs.mkdirSync(project);
  writeFanoutProject(project);

  const plan = await planRun({ projectRoot: project, runId: "escaped-import", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
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
  // The exact bytes matter twice over: this block is sealed into the generated workflow, and the
  // deadline recipe is the only thing that makes the budget checkable by an agent that has no clock
  // but does have a shell (#672/#677). Asserting the literal keeps a reworded or deleted deadline
  // visible here instead of only in a run that dies at its timeout with no artifacts. Every byte is
  // also paid once per task, so the wording is deliberately terse; the reasoning lives in the JSDoc
  // on `topologyRuntimeContextForTimeout`.
  const expectedRuntimeContext = [
    "## Topology Runtime Context",
    "",
    "- Timeout: 1200 seconds total.",
    "- Finalization reserve: 200 seconds.",
    "- Working budget before finalization: 1000 seconds.",
    "- Clock: `date -u +%s` once at start = START; working deadline START+1000, hard deadline START+1200.",
    "- Re-run `date -u +%s` before each expensive step; compare, never estimate.",
    "- Stop starting new delegated or tool work when the finalization reserve begins.",
    "- During the reserve, write and validate every required artifact, marking unfinished work blocked instead of omitting outputs.",
    "- Crossing the hard deadline kills this node with no output at all."
  ].join("\n");
  assert.equal(
    workflowSource.includes(`"runtimeContext": ${JSON.stringify(expectedRuntimeContext)}`),
    true,
    workflowSource
  );
  assert.match(workflowSource, /const fullTaskPrompt = renderEmbeddedPromptTemplate/u);
  assert.match(workflowSource, /runtime_context: task\.runtimeContext/u);
  assert.match(workflowSource, /operator_prompt: operatorPrompt/u);
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
    // #672/#677: a relative budget is unactionable for a model with no clock, which is how nodes
    // reached their timeout having written nothing. Both deadlines must be derivable arithmetic over
    // a start epoch the agent observes itself, and the shell command that observes it must be named.
    assert.match(
      context,
      new RegExp(
        "- Clock: `date -u \\+%s` once at start = START; " +
          `working deadline START\\+${entry.workingSeconds}, hard deadline START\\+${entry.timeoutSeconds}\\.`,
        "u"
      )
    );
    assert.match(context, /`date -u \+%s`/u);
    // A resolved wall-clock timestamp here would be a hard break, not a style problem: this string is
    // serialized into the generated workflow, the workflow file is hashed into the control seal, and
    // `writePreparedWorkflowFile` throws when a re-render disagrees with the bytes already on disk.
    // It would also be semantically wrong, because generation happens once and nodes start hours
    // later. Hence a recipe, and hence this guard against anything date-shaped.
    assert.doesNotMatch(context, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
    // The byte stability that seal and re-prepare both depend on.
    assert.equal(topologyRuntimeContextForTimeout(entry.timeoutMs), context);
  }
});

test("invariant campaign budget admits the shipped 7200-second node timeout", async () => {
  const compiled = await compileInvariantCampaignBudgetFixture({
    logicalNodeId: "stateful-invariant-campaign",
    nodeTimeoutSeconds: 7200,
    smokeTimeoutSeconds: 600,
    fuzzerTimeoutSeconds: 3600,
    runId: "campaign-budget-default"
  });
  assert.equal(compiled.tasks[0]?.timeoutMs, 7_200_000);
});

test("invariant campaign budget rejects an oversized fuzzer timeout with every budget term", async () => {
  await assert.rejects(
    compileInvariantCampaignBudgetFixture({
      logicalNodeId: "stateful-invariant-recon-campaign",
      nodeTimeoutSeconds: 7200,
      smokeTimeoutSeconds: 600,
      fuzzerTimeoutSeconds: 6001,
      runId: "campaign-budget-exceeded"
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /INVARIANT_CAMPAIGN_TIMEOUT_BUDGET_EXCEEDED/u);
      assert.match(error.message, /logical_node_id=stateful-invariant-recon-campaign/u);
      assert.match(error.message, /node_timeout_seconds=7200/u);
      assert.match(error.message, /required_seconds=7201/u);
      assert.match(error.message, /smoke_timeout_seconds=600/u);
      assert.match(error.message, /fuzzer_timeout_seconds=6001/u);
      assert.match(error.message, /host_shutdown_grace_seconds=300/u);
      assert.match(error.message, /artifact_finalization_reserve_seconds=300/u);
      assert.match(error.message, /timeout_seconds to at least 7201/u);
      return true;
    }
  );
});

test("invariant campaign budget honors an explicit larger node timeout", async () => {
  const compiled = await compileInvariantCampaignBudgetFixture({
    logicalNodeId: "stateful-invariant-campaign",
    nodeTimeoutSeconds: 9000,
    smokeTimeoutSeconds: 600,
    fuzzerTimeoutSeconds: 7000,
    runId: "campaign-budget-explicit"
  });
  assert.equal(compiled.tasks[0]?.timeoutMs, 9_000_000);
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

  // Simulate a project scaffolded before ClaudeAgent, DeepSeekAgent, KimiAgent,
  // and PiAgent existed: the registry predates the adapters, and init preserves
  // project-owned files.
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
  assert.equal(stale.length, 4, JSON.stringify(upgraded.diagnostics));
  assert.equal(stale[0]?.severity, "warning");
  assert.match(stale.map((entry) => entry.message).join("\n"), /ClaudeAgent/);
  assert.match(stale.map((entry) => entry.message).join("\n"), /DeepSeekAgent/);
  assert.match(stale.map((entry) => entry.message).join("\n"), /KimiAgent/);
  assert.match(stale.map((entry) => entry.message).join("\n"), /PiAgent/);

  // A registry that names Claude, DeepSeek, Kimi, and Pi without registering
  // their factories is still stale: nothing resolves it, since generated
  // adapters export only factories.
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
  assert.equal(namedStale.length, 4, JSON.stringify(named.diagnostics));
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /ClaudeAgent/);
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /DeepSeekAgent/);
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /KimiAgent/);
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /PiAgent/);

  // A registry that exports every generated agent stays quiet.
  const regenerated = initProject({ projectRoot: project, force: true });
  assert.equal(
    regenerated.diagnostics.filter((entry) => entry.code === "INIT_AGENT_REGISTRY_STALE").length,
    0,
    JSON.stringify(regenerated.diagnostics)
  );
});

test(
  "post-init registry inspection sanitizes access failures instead of failing after mutation",
  { concurrency: false },
  () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const registryPath = path.join(project, ".smithers", "agents", "index.ts");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
    const originalOpenSync = fs.openSync;

    Object.defineProperty(fs, "openSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        if (String(args[0]) === registryPath) {
          throw Object.assign(new Error("sensitive registry access detail"), { code: "EACCES" });
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      }
    });
    try {
      const inspected = initProject({ projectRoot: project });
      assert.equal(inspected.ok, true, JSON.stringify(inspected.diagnostics));
      const warning = inspected.diagnostics.find(
        (diagnostic) => diagnostic.code === "INIT_AGENT_REGISTRY_REVIEW_REQUIRED"
      );
      assert.equal(warning?.severity, "warning");
      assert.match(warning?.message ?? "", /could not be safely inspected/u);
      assert.match(warning?.message ?? "", /verify manually/u);
      assert.doesNotMatch(JSON.stringify(inspected.diagnostics), /sensitive registry|EACCES/u);
    } finally {
      Object.defineProperty(fs, "openSync", originalDescriptor);
    }
  }
);

test(
  "post-init registry inspection rejects symlinks, FIFOs, and oversized files without reading them",
  { skip: process.platform === "win32" },
  () => {
    const cases = ["symlink", "fifo", "oversized"] as const;
    for (const kind of cases) {
      const project = tempProject();
      assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
      const registryPath = path.join(project, ".smithers", "agents", "index.ts");
      fs.unlinkSync(registryPath);
      if (kind === "symlink") {
        const outside = path.join(tempProject(), "outside-index.ts");
        fs.writeFileSync(outside, "outside registry must not be read\n", "utf8");
        fs.symlinkSync(outside, registryPath);
      } else if (kind === "fifo") {
        execFileSync("mkfifo", [registryPath]);
      } else {
        fs.writeFileSync(registryPath, Buffer.alloc(256 * 1024 + 1, 0x61));
      }

      const inspected = initProject({ projectRoot: project });

      assert.equal(inspected.ok, true, `${kind}: ${JSON.stringify(inspected.diagnostics)}`);
      const warning = inspected.diagnostics.find(
        (diagnostic) => diagnostic.code === "INIT_AGENT_REGISTRY_REVIEW_REQUIRED"
      );
      assert.equal(warning?.severity, "warning", kind);
      assert.match(warning?.message ?? "", /preserved (?:it )?without inspection|too large to inspect/u, kind);
      assert.match(warning?.message ?? "", /verify manually/u, kind);
    }
  }
);

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
      artifactDir?: string;
      metadata?: {
        node?: { concreteNodeId?: string };
        model?: { modelName?: string; reasoningEffort?: string };
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
  assert.equal(smithersTasks.tasks[0]?.artifactDir, path.join(run.value!.run_root, "artifacts", "project-discovery"));
  assert.notEqual(smithersTasks.tasks[0]?.artifactDir, smithersTasks.tasks[0]?.workspacePath);
  assert.ok(smithersTasks.tasks.every((task) => typeof task.timeoutMs === "number"));
  assert.ok(smithersTasks.tasks.every((task) => typeof task.retries === "number"));
  assert.ok(smithersTasks.tasks.every((task) => task.retryPolicy !== null));
  assert.equal(smithersTasks.tasks[0]?.metadata?.node?.concreteNodeId, "project-discovery");
  assert.equal(smithersTasks.tasks[0]?.metadata?.model?.modelName, "gpt-runtime-override");
  assert.equal(smithersTasks.tasks[0]?.metadata?.model?.reasoningEffort, "max");
  const localRunMetadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    workflow?: { execution_snapshot_path?: string };
  };
  const localExecutionSnapshot = path.join(
    run.value!.run_root,
    localRunMetadata.workflow?.execution_snapshot_path ?? ""
  );
  const localDependencyManifest = JSON.parse(
    fs.readFileSync(path.join(localExecutionSnapshot, "dependencies", "manifest.json"), "utf8")
  ) as { smithers_bin?: unknown };
  assert.equal(
    localDependencyManifest.smithers_bin,
    null,
    "a pure-local workflow may keep using its explicit controller runner without sealing the pinned package"
  );

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
  assert.match(workflowSource, /function assertTaskInputs/);
  assert.match(workflowSource, /artifact handoff directory is unavailable/);
  assert.match(workflowSource, /function canonicalEmptyArtifact/);
  assert.match(workflowSource, /output\.primary && output\.contract !== "ultrafuzz\/findings@1"/);
  assert.match(workflowSource, /artifactContractDefinition\(output\.contract\)\.validEmptyExample/);
  assert.match(workflowSource, /function artifactAwareAgent/);
  assert.match(
    workflowSource,
    /const result = await agent\.generate\(attemptArgs\);[\s\S]*?prepareArtifactMirror\(task, \{ replayWorkspacePatches: false, pinnedSubmodules: "verify" \}\);/
  );
  assert.match(workflowSource, /materializeMissingMarkdownArtifacts\(task, result\)/);
  assert.match(workflowSource, /normalizeLegacyFindingFields\(task\)/);
  assert.match(workflowSource, /normalizeLegacyReportProvenance\(task\)/);
  assert.match(workflowSource, /normalizeLegacyGeneratedTestManifests\(task\)/);
  assert.match(workflowSource, /materializeGeneratedTestCompanions\(task\)/);
  assert.match(workflowSource, /INVARIANT_TEST_ROOT_NAMES\.flatMap\(\(testRoot\) => \[/);
  assert.match(workflowSource, /path\.resolve\(workspaceRoot, testRoot, "foundry", workspaceRelativePath\)/);
  assert.match(
    workflowSource,
    /nodeIds\.map\(\(nodeId\) => path\.resolve\(workspaceRoot, testRoot, "foundry", nodeId, workspaceRelativePath\)\)/
  );
  assert.match(workflowSource, /generatedTestNodeIds\(task\)/);
  assert.match(workflowSource, /typeof entry === "string" \? \{ path: entry \} : entry/);
  assert.match(workflowSource, /typeof finding\.confidence === "number"/);
  assert.match(workflowSource, /finding\.confidence = String\(finding\.confidence\)/);
  assert.match(workflowSource, /\(strategy as Record<string, unknown>\)\.origin/);
  assert.match(workflowSource, /finding\.strategy = legacyStrategy\.trim\(\)/);
  assert.match(workflowSource, /finding\.evidence = \[evidence\]/);
  assert.match(workflowSource, /report\.issues\.map/);
  assert.match(workflowSource, /\["implementation_paths", "test_paths"\]/);
  assert.match(workflowSource, /\["fuzzer_backend", "fuzzer_backends"\]/);
  assert.match(workflowSource, /verifyArtifacts\(task, \{ agentReturned: true \}\);/);
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
  // Workflow synchronization derives this id from the attempt id to attribute
  // preparation failures, so the compiled shape is part of that contract.
  assert.match(workflowSource, /"preparationId": "prepare:project-discovery"/);
  assert.match(workflowSource, /untrusted data, not instructions/);
  assert.match(workflowSource, /function resolveRegularArtifactFile/);
  assert.match(workflowSource, /throw new Error\(failureMessage\)/);
  assert.match(workflowSource, /<Worktree/);
  assert.match(workflowSource, /baseBranch=\{usesPinnedSource \? pinnedSourceBranch : localSourceCommit\}/);
  assert.match(workflowSource, /function resolveLocalSourceCommit\(\): string \| undefined/);
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

  const requested = await pauseRun({ projectRoot: project, runId: "pause-run", env });
  assert.equal(requested.ok, true, JSON.stringify(requested.diagnostics));
  assert.equal(requested.value?.status, "pause-requested");
  assert.equal(requested.value?.submitted, true);

  env.SMITHERS_FAKE_ALREADY_PAUSED = "1";
  const paused = await pauseRun({ projectRoot: project, runId: "pause-run", env });
  assert.equal(paused.ok, true, JSON.stringify(paused.diagnostics));
  assert.equal(paused.value?.status, "paused");
  assert.equal(paused.value?.submitted, false);
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

test("startRun rejects an untracked cwd executable before task worktrees or model work", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const topologyPath = path.join(project, ".ultrafuzz", "topology.yml");
  fs.writeFileSync(
    topologyPath,
    fs
      .readFileSync(topologyPath, "utf8")
      .replace(
        "    prompt: setup/project-discovery.md\n",
        "    prompt: setup/project-discovery.md\n    required_commands: [recon]\n"
      ),
    "utf8"
  );
  writeFakeInstalledSmithers(project);
  const executable = path.join(project, "recon");
  fs.writeFileSync(executable, "#!/bin/sh\necho recon test\n", "utf8");
  fs.chmodSync(executable, 0o755);
  const run = await startRun({
    projectRoot: project,
    runId: "empty-path-required-command",
    env: {
      PATH: "",
      SMITHERS_FAKE_LOG: path.join(project, "smithers-commands.log")
    }
  });

  assert.equal(run.ok, false);
  assert.equal(run.diagnostics[0]?.code, "RUN_REQUIRED_COMMAND_MISSING");
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "runs", "empty-path-required-command")), false);
});

test("startRun rejects controller-only paths as credential environment names", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace('api_key_env = "OPENAI_API_KEY"', 'api_key_env = "ULTRAFUZZ_CONFIG_PATH"'),
    "utf8"
  );

  const env = fakeSmithersEnv(project);
  const run = await startRun({
    projectRoot: project,
    runId: "controller-path-credential",
    env
  });

  assert.equal(run.ok, false);
  assert.match(run.diagnostics[0]?.message ?? "", /credential environment cannot name controller-only variable/u);
  assert.equal(fs.existsSync(env.SMITHERS_FAKE_LOG!), false);
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
  const pinnedRunner = writeFakeInstalledSmithers(project);
  fs.writeFileSync(
    pinnedRunner.target,
    [
      "#!/bin/sh",
      'if [ -n "$SMITHERS_FAKE_CLOUD_ENV_LOG" ] && [ "$1" = "up" ]; then',
      '  printf \'%s|%s\\n\' "$UFZ_PROVIDER_ONE" "$UFZ_PROVIDER_TWO" >> "$SMITHERS_FAKE_CLOUD_ENV_LOG"',
      "fi",
      "printf '%s\\n' '{\"ok\":true}'",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(pinnedRunner.target, 0o755);
  const controllerEnvironment = fakeSmithersEnv(project);
  const env = {
    ...controllerEnvironment,
    SMITHERS_FAKE_CLOUD_ENV_LOG: cloudEnvironmentLog,
    OPENAI_API_KEY: "configured-agent-key",
    UFZ_PROVIDER_ONE: "provider-one",
    UFZ_PROVIDER_TWO: "provider-two"
  };

  const run = await startRun({ projectRoot: project, runId: "cloud-environment", env });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(cloudEnvironmentLog, "utf8"), "provider-one|provider-two\n");
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    workflow?: { execution_snapshot_path?: string };
  };
  const executionSnapshot = path.join(run.value!.run_root, metadata.workflow?.execution_snapshot_path ?? "");
  const dependencyManifest = JSON.parse(
    fs.readFileSync(path.join(executionSnapshot, "dependencies", "manifest.json"), "utf8")
  ) as { smithers_bin?: unknown };
  assert.equal(typeof dependencyManifest.smithers_bin, "string");
  assert.notEqual(dependencyManifest.smithers_bin, "");
  assert.notEqual(
    path.resolve(executionSnapshot, String(dependencyManifest.smithers_bin)),
    fs.realpathSync(controllerEnvironment.SMITHERS_BIN!),
    "cloud execution must use the sealed pinned runner rather than a host-only controller override"
  );
  const sealedCloudRunner = path.join(executionSnapshot, ...String(dependencyManifest.smithers_bin).split("/"));
  assert.equal(fs.statSync(sealedCloudRunner).isFile(), true);
  assert.notEqual(fs.statSync(sealedCloudRunner).mode & 0o111, 0);
  assert.deepEqual(fs.readFileSync(sealedCloudRunner), fs.readFileSync(pinnedRunner.target));
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

test("startRun submits the exact sealed redacted workflow input bytes", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  const commandLog = path.join(project, "smithers-command.log");
  const inputLog = path.join(project, "smithers-input.log");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" > "$SMITHERS_FAKE_LOG"',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--input" ]; then',
      "    shift",
      '    printf \'%s\' "$1" > "$SMITHERS_FAKE_INPUT_LOG"',
      "    break",
      "  fi",
      "  shift",
      "done",
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
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_BIN: smithers,
      SMITHERS_FAKE_LOG: commandLog,
      SMITHERS_FAKE_INPUT_LOG: inputLog
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const sealedInputBytes = fs.readFileSync(path.join(run.value!.run_root, "smithers", "input.json"));
  const submittedInputBytes = fs.readFileSync(inputLog);
  assert.deepEqual(submittedInputBytes, sealedInputBytes);
  const evidence = await readLinkedWorkflowEvidence(project, "redacted-evidence");
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  assert.equal(evidence.executionSnapshot.inputJson, sealedInputBytes.toString("utf8"));

  const operationalCommand = fs.readFileSync(commandLog, "utf8");
  assert.doesNotMatch(operationalCommand, /sk-(?:operator|nested)/u);
  const inputEvidence = JSON.parse(sealedInputBytes.toString("utf8")) as {
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

test("snapshot recovery removes a nested read-only stale current-generation publication before retry", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "snapshot-stale-publication-retry";
  const run = await startRun({ projectRoot: project, runId, env: fakeSmithersEnv(project) });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;

  const generation = evidence.verifiedControl.generation;
  const snapshotsRoot = path.dirname(evidence.executionSnapshot.root);
  const savedSnapshot = `${snapshotsRoot}.saved-${generation}`;
  fs.chmodSync(evidence.executionSnapshot.root, 0o700);
  fs.renameSync(evidence.executionSnapshot.root, savedSnapshot);
  const staleRoot = path.join(snapshotsRoot, `.${generation}.tmp-${process.pid}-${"a".repeat(24)}`);
  const readOnlyNested = path.join(staleRoot, "read-only", "nested");
  fs.mkdirSync(readOnlyNested, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(readOnlyNested, "partial.txt"), "partial publication\n", { mode: 0o400 });
  fs.chmodSync(readOnlyNested, 0o500);
  fs.chmodSync(path.dirname(readOnlyNested), 0o500);
  fs.chmodSync(staleRoot, 0o500);

  const recovered = materializeWorkflowExecutionSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    snapshot: evidence.verifiedControl
  });

  assert.equal(recovered.root, evidence.executionSnapshot.root);
  assert.equal(recovered.inputJson, evidence.executionSnapshot.inputJson);
  assert.deepEqual(fs.readdirSync(snapshotsRoot), [generation]);
  assert.equal(fs.existsSync(staleRoot), false);
  assert.equal(fs.existsSync(savedSnapshot), true);
});

test("snapshot recovery rejects matching symlink and non-directory publications without escaping", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "snapshot-stale-publication-type";
  const run = await startRun({ projectRoot: project, runId, env: fakeSmithersEnv(project) });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;

  const generation = evidence.verifiedControl.generation;
  const snapshotsRoot = path.dirname(evidence.executionSnapshot.root);
  const savedSnapshot = `${snapshotsRoot}.saved-${generation}`;
  fs.chmodSync(evidence.executionSnapshot.root, 0o700);
  fs.renameSync(evidence.executionSnapshot.root, savedSnapshot);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-stale-snapshot-outside-"));
  const outsideMarker = path.join(outside, "outside.txt");
  fs.writeFileSync(outsideMarker, "outside remains\n", "utf8");
  const symlinkPublication = path.join(snapshotsRoot, `.${generation}.tmp-${process.pid}-${"b".repeat(24)}`);
  fs.symlinkSync(outside, symlinkPublication, process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () =>
      materializeWorkflowExecutionSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        snapshot: evidence.verifiedControl
      }),
    /stale workflow execution snapshot publication is not a physical directory/u
  );
  assert.equal(fs.lstatSync(symlinkPublication).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outsideMarker, "utf8"), "outside remains\n");

  fs.unlinkSync(symlinkPublication);
  const filePublication = path.join(snapshotsRoot, `.${generation}.tmp-${process.pid + 1}-${"c".repeat(24)}`);
  fs.writeFileSync(filePublication, "not a directory\n", "utf8");
  assert.throws(
    () =>
      materializeWorkflowExecutionSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        snapshot: evidence.verifiedControl
      }),
    /stale workflow execution snapshot publication is not a physical directory/u
  );
  assert.equal(fs.readFileSync(filePublication, "utf8"), "not a directory\n");
  assert.equal(fs.readFileSync(outsideMarker, "utf8"), "outside remains\n");
  assert.equal(fs.existsSync(savedSnapshot), true);
});

test("snapshot recovery preserves and rejects unrelated and other-generation entries", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "snapshot-stale-publication-unrelated";
  const run = await startRun({ projectRoot: project, runId, env: fakeSmithersEnv(project) });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;

  const generation = evidence.verifiedControl.generation;
  const otherGeneration = `${generation[0] === "0" ? "1" : "0"}${generation.slice(1)}`;
  const snapshotsRoot = path.dirname(evidence.executionSnapshot.root);
  const savedSnapshot = `${snapshotsRoot}.saved-${generation}`;
  fs.chmodSync(evidence.executionSnapshot.root, 0o700);
  fs.renameSync(evidence.executionSnapshot.root, savedSnapshot);
  const unrelated = path.join(snapshotsRoot, "operator-note");
  fs.writeFileSync(unrelated, "retain\n", "utf8");
  const otherGenerationPublication = path.join(
    snapshotsRoot,
    `.${otherGeneration}.tmp-${process.pid}-${"d".repeat(24)}`
  );
  fs.mkdirSync(otherGenerationPublication, { mode: 0o700 });
  fs.writeFileSync(path.join(otherGenerationPublication, "retain.txt"), "retain other generation\n", "utf8");

  assert.throws(
    () =>
      materializeWorkflowExecutionSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        snapshot: evidence.verifiedControl
      }),
    /workflow execution snapshots contain an unexpected generation/u
  );
  assert.equal(fs.readFileSync(unrelated, "utf8"), "retain\n");
  assert.equal(
    fs.readFileSync(path.join(otherGenerationPublication, "retain.txt"), "utf8"),
    "retain other generation\n"
  );
  assert.equal(fs.existsSync(savedSnapshot), true);
  assert.equal(fs.existsSync(evidence.executionSnapshot.root), false);
});

test(
  "snapshot materialization resists a swapped snapshots parent without writing outside the run",
  { concurrency: false },
  async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = "snapshot-parent-swap";
    const snapshotsRoot = path.join(project, ".ultrafuzz", "runs", runId, "smithers", "execution-snapshots");
    const displacedRoot = `${snapshotsRoot}.displaced`;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-snapshot-parent-outside-"));
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "mkdirSync")!;
    const originalMkdirSync = fs.mkdirSync;
    let swapped = false;
    Object.defineProperty(fs, "mkdirSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        const candidate = String(args[0]);
        if (!swapped && /^\.[0-9a-f]{64}\.tmp-/u.test(path.basename(candidate))) {
          swapped = true;
          fs.renameSync(snapshotsRoot, displacedRoot);
          fs.symlinkSync(outside, snapshotsRoot, process.platform === "win32" ? "junction" : "dir");
        }
        return Reflect.apply(originalMkdirSync, fs, args) as string | undefined;
      }
    });
    try {
      const run = await startRun({ projectRoot: project, runId, env: fakeSmithersEnv(project) });
      assert.equal(run.ok, false);
      assert.equal(swapped, true);
      assert.deepEqual(fs.readdirSync(outside), []);
      assert.deepEqual(fs.readdirSync(displacedRoot), []);
    } finally {
      Object.defineProperty(fs, "mkdirSync", originalDescriptor);
      if (fs.lstatSync(snapshotsRoot).isSymbolicLink()) fs.unlinkSync(snapshotsRoot);
      if (fs.existsSync(displacedRoot)) fs.renameSync(displacedRoot, snapshotsRoot);
    }
  }
);

test(
  "snapshot materialization keeps every write on the opened root after its parent is swapped",
  { concurrency: false },
  async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = "snapshot-write-swap";
    const snapshotsRoot = path.join(project, ".ultrafuzz", "runs", runId, "smithers", "execution-snapshots");
    const displacedRoot = `${snapshotsRoot}.displaced`;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-snapshot-write-outside-"));
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "fchmodSync")!;
    const originalFchmodSync = fs.fchmodSync;
    let swapped = false;
    Object.defineProperty(fs, "fchmodSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        const result = Reflect.apply(originalFchmodSync, fs, args) as void;
        let candidate = "";
        try {
          candidate = fs.realpathSync(`/proc/self/fd/${String(args[0])}`);
        } catch {
          // Leave the candidate empty when this descriptor cannot be resolved.
        }
        if (!swapped && /(?:^|\/)\.[0-9a-f]{64}\.tmp-/u.test(candidate) && fs.existsSync(snapshotsRoot)) {
          swapped = true;
          fs.renameSync(snapshotsRoot, displacedRoot);
          fs.symlinkSync(outside, snapshotsRoot, process.platform === "win32" ? "junction" : "dir");
        }
        return result;
      }
    });
    try {
      const run = await startRun({ projectRoot: project, runId, env: fakeSmithersEnv(project) });
      assert.equal(run.ok, false);
      assert.equal(swapped, true);
      assert.deepEqual(fs.readdirSync(outside), []);
      assert.deepEqual(fs.readdirSync(displacedRoot), []);
    } finally {
      Object.defineProperty(fs, "fchmodSync", originalDescriptor);
      if (fs.lstatSync(snapshotsRoot).isSymbolicLink()) fs.unlinkSync(snapshotsRoot);
      if (fs.existsSync(displacedRoot)) fs.renameSync(displacedRoot, snapshotsRoot);
    }
  }
);

test(
  "snapshot materialization resists an intermediate directory swap before a file open",
  { concurrency: false },
  async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = "snapshot-intermediate-write-swap";
    const snapshotsRoot = path.join(project, ".ultrafuzz", "runs", runId, "smithers", "execution-snapshots");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-snapshot-intermediate-outside-"));
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
    const originalOpenSync = fs.openSync;
    let swapped = false;
    Object.defineProperty(fs, "openSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        const candidate = String(args[0]);
        let controls: string | undefined;
        if (!swapped && candidate.startsWith("/proc/self/fd/") && path.basename(candidate) === "plan.json") {
          try {
            const parent = fs.realpathSync(path.dirname(candidate));
            if (
              path.basename(parent) === "controls" &&
              /^\.[0-9a-f]{64}\.tmp-/u.test(path.basename(path.dirname(parent))) &&
              path.dirname(path.dirname(parent)) === snapshotsRoot
            ) {
              controls = parent;
            }
          } catch {
            controls = undefined;
          }
        }
        if (controls !== undefined) {
          fs.renameSync(controls, `${controls}.displaced`);
          fs.symlinkSync(outside, controls, "dir");
          swapped = true;
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      }
    });
    try {
      const run = await startRun({ projectRoot: project, runId, env: fakeSmithersEnv(project) });
      assert.equal(run.ok, false);
      assert.equal(swapped, true);
      assert.deepEqual(fs.readdirSync(outside), []);
      assert.deepEqual(fs.readdirSync(snapshotsRoot), []);
    } finally {
      Object.defineProperty(fs, "openSync", originalDescriptor);
    }
  }
);

test("snapshot permission sealing cannot chmod a swapped outside leaf", { concurrency: false }, async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "snapshot-chmod-leaf-swap";
  const snapshotsRoot = path.join(project, ".ultrafuzz", "runs", runId, "smithers", "execution-snapshots");
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ufz-snapshot-chmod-outside-")), "outside.txt");
  fs.writeFileSync(outside, "outside\n", { mode: 0o600 });
  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "fchmodSync")!;
  const originalFchmodSync = fs.fchmodSync;
  let swapped = false;
  Object.defineProperty(fs, "fchmodSync", {
    ...originalDescriptor,
    value: (...args: unknown[]) => {
      let candidate = "";
      try {
        candidate = fs.realpathSync(`/proc/self/fd/${String(args[0])}`);
      } catch {
        // Leave the candidate empty when this descriptor cannot be resolved.
      }
      if (!swapped && candidate.endsWith("/controls/plan.json") && candidate.includes(`${path.sep}.`)) {
        fs.renameSync(candidate, `${candidate}.displaced`);
        fs.symlinkSync(outside, candidate);
        swapped = true;
      }
      return Reflect.apply(originalFchmodSync, fs, args) as void;
    }
  });
  try {
    const run = await startRun({ projectRoot: project, runId, env: fakeSmithersEnv(project) });
    assert.equal(run.ok, false);
    assert.equal(swapped, true);
    assert.equal(fs.statSync(outside).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");
    assert.deepEqual(fs.readdirSync(snapshotsRoot), []);
  } finally {
    Object.defineProperty(fs, "fchmodSync", originalDescriptor);
  }
});

test(
  "snapshot publication removes a renamed generation when its durability flush fails",
  { concurrency: false },
  async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const runId = "snapshot-post-rename-cleanup";
    const snapshotsRoot = path.join(project, ".ultrafuzz", "runs", runId, "smithers", "execution-snapshots");
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "fsyncSync")!;
    const originalFsyncSync = fs.fsyncSync;
    let rejectedPublication = false;
    Object.defineProperty(fs, "fsyncSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        if (
          !rejectedPublication &&
          fs.existsSync(snapshotsRoot) &&
          fs.readdirSync(snapshotsRoot).some((entry) => /^[0-9a-f]{64}$/u.test(entry))
        ) {
          rejectedPublication = true;
          throw new Error("injected post-rename durability failure");
        }
        return Reflect.apply(originalFsyncSync, fs, args) as void;
      }
    });
    try {
      const run = await startRun({ projectRoot: project, runId, env: fakeSmithersEnv(project) });
      assert.equal(run.ok, false);
      assert.equal(rejectedPublication, true);
      assert.deepEqual(fs.readdirSync(snapshotsRoot), []);
    } finally {
      Object.defineProperty(fs, "fsyncSync", originalDescriptor);
    }
  }
);

test("snapshot materialization closes ownership descriptors on pre-publication validation failures", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "snapshot-early-failure-cleanup", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, "snapshot-early-failure-cleanup");
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const snapshotsRoot = path.dirname(evidence.executionSnapshot.root);
  const workflowRelative = path.posix.join(".smithers/workflows", path.basename(evidence.workflowPath));
  const collision = {
    ...evidence.verifiedControl,
    executionFiles: [
      ...evidence.verifiedControl.executionFiles,
      { sourcePath: evidence.workflowPath, snapshotPath: workflowRelative, contents: Buffer.from("collision\n") }
    ]
  };
  assert.throws(
    () => materializeWorkflowExecutionSnapshot({ projectRoot: project, layout: evidence.layout, snapshot: collision }),
    /collides with its generated workflow/u
  );
  assert.deepEqual(openDescriptorTargetsInside(snapshotsRoot), []);

  const malformedDependencyMap = {
    ...evidence.verifiedControl,
    executionFiles: evidence.verifiedControl.executionFiles.map((file) =>
      file.snapshotPath === "dependencies/manifest.json" ? { ...file, contents: Buffer.from("{}\n") } : file
    )
  };
  assert.throws(
    () =>
      materializeWorkflowExecutionSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        snapshot: malformedDependencyMap
      }),
    /dependency map is invalid/u
  );
  assert.deepEqual(openDescriptorTargetsInside(snapshotsRoot), []);
});

test("snapshot command anchoring rejects a same-target link pathname swap", { concurrency: false }, async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "snapshot-link-swap", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, "snapshot-link-swap");
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const controllerEnvironment = linkedWorkflowExecutionEnvironment(evidence, env);
  const anchor = acquireWorkflowExecutionSnapshotAnchor(controllerEnvironment);
  assert.ok(anchor);
  const link = firstSymlinkUnder(evidence.executionSnapshot.root);
  assert.ok(link, "the sealed module graph did not contain a dependency link");
  const displaced = `${link}.displaced`;
  const target = fs.readlinkSync(link);
  const parent = path.dirname(link);
  const parentMode = fs.statSync(parent).mode & 0o777;
  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "readlinkSync")!;
  const originalReadlinkSync = fs.readlinkSync;
  let swapped = false;
  Object.defineProperty(fs, "readlinkSync", {
    ...originalDescriptor,
    value: (...args: unknown[]) => {
      const observed = Reflect.apply(originalReadlinkSync, fs, args) as string | Buffer;
      const candidate = String(args[0]);
      if (!swapped && candidate.endsWith(path.relative(evidence.executionSnapshot.root, link))) {
        fs.chmodSync(parent, 0o700);
        fs.renameSync(link, displaced);
        fs.symlinkSync(target, link, "dir");
        fs.chmodSync(parent, parentMode);
        swapped = true;
      }
      return observed;
    }
  });
  try {
    assert.throws(
      () => anchor.assertCurrent(),
      /workflow execution snapshot entry changed at the controller command boundary/u
    );
    assert.equal(swapped, true);
  } finally {
    Object.defineProperty(fs, "readlinkSync", originalDescriptor);
    fs.chmodSync(parent, 0o700);
    if (fs.existsSync(link)) fs.unlinkSync(link);
    if (fs.existsSync(displaced)) fs.renameSync(displaced, link);
    fs.chmodSync(parent, parentMode);
    anchor.close();
  }
});

test("snapshot command anchoring rejects undeclared files and links", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "snapshot-extra-entry", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, "snapshot-extra-entry");
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const anchor = acquireWorkflowExecutionSnapshotAnchor(linkedWorkflowExecutionEnvironment(evidence, env));
  assert.ok(anchor);
  const extraFile = path.join(evidence.executionSnapshot.root, "undeclared-control.txt");
  const extraLink = path.join(evidence.executionSnapshot.root, "undeclared-control-link");
  const rootMode = fs.statSync(evidence.executionSnapshot.root).mode & 0o777;
  fs.chmodSync(evidence.executionSnapshot.root, 0o700);
  fs.writeFileSync(extraFile, "undeclared\n", "utf8");
  fs.symlinkSync(".smithers", extraLink, "dir");
  fs.chmodSync(evidence.executionSnapshot.root, rootMode);
  try {
    assert.throws(
      () => anchor.assertCurrent(),
      /workflow execution snapshot directory changed at the controller command boundary/u
    );
  } finally {
    anchor.close();
    fs.chmodSync(evidence.executionSnapshot.root, 0o700);
    fs.unlinkSync(extraFile);
    fs.unlinkSync(extraLink);
    fs.chmodSync(evidence.executionSnapshot.root, rootMode);
  }
});

test("snapshot anchoring fails closed when descriptor paths are unavailable", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "snapshot-lexical-fallback", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, "snapshot-lexical-fallback");
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  assert.throws(
    () =>
      acquireWorkflowExecutionSnapshotAnchor(linkedWorkflowExecutionEnvironment(evidence, env), {
        openDirectory: () => undefined,
        directoryDescriptorPath: () => undefined,
        controllerDirectoryDescriptorPath: () => undefined
      }),
    /no descriptor anchor/u
  );
  assert.throws(
    () =>
      acquireWorkflowExecutionSnapshotAnchor(linkedWorkflowExecutionEnvironment(evidence, env), {
        controllerDirectoryDescriptorPath: () => undefined
      }),
    /no cross-process descriptor path/u
  );
  assert.deepEqual(openDescriptorTargetsInside(evidence.executionSnapshot.root), []);
});

test("snapshot anchors close when executable acquisition rejects a replaced interpreter", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const installed = writeFakeInstalledSmithers(project);
  const interpreter = path.join(project, "sealed-runner-interpreter");
  fs.copyFileSync("/bin/sh", interpreter);
  fs.chmodSync(interpreter, 0o755);
  fs.writeFileSync(installed.target, `#!${interpreter}\nprintf '%s\\n' '{"ok":true}'\n`, "utf8");
  fs.chmodSync(installed.target, 0o755);
  const env = { PATH: "", SMITHERS_FAKE_LOG: path.join(project, "snapshot-anchor-cleanup.log") };
  const run = await startRun({ projectRoot: project, runId: "snapshot-anchor-cleanup", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, "snapshot-anchor-cleanup");
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const displacedInterpreter = `${interpreter}.displaced`;
  fs.renameSync(interpreter, displacedInterpreter);
  fs.copyFileSync(displacedInterpreter, interpreter);
  fs.chmodSync(interpreter, 0o755);

  const inspected = await runSmithersInspectionCommand({
    args: ["inspect", evidence.smithersRunId, "--format", "json"],
    projectRoot: project,
    env: linkedWorkflowExecutionEnvironment(evidence, env)
  });

  assert.equal(inspected.ok, false);
  assert.match(inspected.error ?? "", /interpreter changed|interpreter identity/u);
  assert.deepEqual(openDescriptorTargetsInside(evidence.executionSnapshot.root), []);
});

test("snapshot anchors close when controller environment rewriting fails", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "snapshot-rewrite-cleanup", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, "snapshot-rewrite-cleanup");
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const controllerEnv = linkedWorkflowExecutionEnvironment(evidence, env);
  Object.defineProperty(controllerEnv, "ULTRAFUZZ_REWRITE_TRAP", {
    enumerable: true,
    get: () => {
      throw new Error("controller environment rewrite trap");
    }
  });

  const inspected = await runSmithersInspectionCommand({
    args: ["inspect", evidence.smithersRunId, "--format", "json"],
    projectRoot: project,
    env: controllerEnv
  });

  assert.equal(inspected.ok, false);
  assert.match(inspected.error ?? "", /controller environment rewrite trap/u);
  assert.deepEqual(openDescriptorTargetsInside(evidence.executionSnapshot.root), []);
});

test("linked lifecycle commands reuse sealed bytes after mutable project sources are replaced", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "snapshot-source-replacement", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const runRoot = run.value!.run_root;
  const metadata = JSON.parse(fs.readFileSync(path.join(runRoot, "run.json"), "utf8")) as {
    workflow?: { path?: string };
  };
  const plan = JSON.parse(fs.readFileSync(path.join(runRoot, "plan.json"), "utf8")) as {
    rendered_prompts?: Array<{ attempt_id?: string; rendered_prompt_path?: string }>;
  };
  const renderedPrompt = plan.rendered_prompts?.find(
    (candidate) => typeof candidate.attempt_id === "string" && typeof candidate.rendered_prompt_path === "string"
  );
  assert.ok(renderedPrompt?.attempt_id);
  assert.ok(renderedPrompt.rendered_prompt_path);
  const mutableWorkflow = path.join(project, ...(metadata.workflow?.path ?? "").split("/"));
  fs.writeFileSync(mutableWorkflow, "export default function HostileReplacement() {}\n", "utf8");
  fs.writeFileSync(path.join(project, "ultrafuzz.toml"), '[project]\nname = "hostile-replacement"\n', "utf8");
  fs.writeFileSync(path.join(project, ".smithers", "agents", "codex.ts"), "export const hostile = true;\n", "utf8");
  fs.writeFileSync(path.join(project, ".smithers", "package.json"), "{}\n", "utf8");
  fs.writeFileSync(renderedPrompt.rendered_prompt_path, "HOSTILE_MUTABLE_PROMPT\n", "utf8");

  const evidence = await readLinkedWorkflowEvidence(project, "snapshot-source-replacement");
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  assert.doesNotMatch(fs.readFileSync(evidence.workflowPath, "utf8"), /HostileReplacement/u);
  assert.doesNotMatch(fs.readFileSync(evidence.executionSnapshot.env.ULTRAFUZZ_CONFIG_PATH!, "utf8"), /hostile/u);
  assert.doesNotMatch(
    fs.readFileSync(path.join(evidence.executionSnapshot.root, ".smithers", "agents", "codex.ts"), "utf8"),
    /hostile/u
  );
  assert.doesNotMatch(
    fs.readFileSync(
      path.join(evidence.executionSnapshot.root, "controls", "rendered-prompts", `${renderedPrompt.attempt_id}.md`),
      "utf8"
    ),
    /HOSTILE_MUTABLE_PROMPT/u
  );

  const snapshotBytesLog = path.join(project, "snapshot-consumed-bytes.log");
  env.SMITHERS_FAKE_SNAPSHOT_BYTES_LOG = snapshotBytesLog;
  env.SMITHERS_FAKE_SNAPSHOT_ATTEMPT = renderedPrompt.attempt_id;
  const resumed = await resumeRun({ projectRoot: project, runId: "snapshot-source-replacement", env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  const consumed = fs.readFileSync(snapshotBytesLog, "utf8");
  assert.match(consumed, /^workflow=\/proc\/(?:self|[1-9][0-9]*)\/fd\/[0-9]+\/\.smithers\/workflows\//mu);
  assert.match(consumed, /^config=\/proc\/(?:self|[1-9][0-9]*)\/fd\/[0-9]+\/controls\/ultrafuzz\.toml$/mu);
  assert.match(
    consumed,
    new RegExp(
      `^prompt=/proc/(?:self|[1-9][0-9]*)/fd/[0-9]+/controls/rendered-prompts/${renderedPrompt.attempt_id}\\.md$`,
      "mu"
    )
  );
  assert.match(consumed, /^agent=\/proc\/(?:self|[1-9][0-9]*)\/fd\/[0-9]+\/\.smithers\/agents\/codex\.ts$/mu);
  assert.doesNotMatch(consumed, /HostileReplacement|hostile-replacement|export const hostile|HOSTILE_MUTABLE_PROMPT/u);
});

test("linked evidence rejects extra snapshot generations and malformed control seal keys", async () => {
  const extraProject = tempProject();
  initProject({ projectRoot: extraProject, force: true });
  writeSmallTopology(extraProject);
  const extraRun = await startRun({
    projectRoot: extraProject,
    runId: "snapshot-extra-generation",
    env: fakeSmithersEnv(extraProject)
  });
  assert.equal(extraRun.ok, true, JSON.stringify(extraRun.diagnostics));
  const snapshotsRoot = path.join(extraRun.value!.run_root, "smithers", "execution-snapshots");
  fs.mkdirSync(path.join(snapshotsRoot, "unexpected-generation"), { mode: 0o700 });
  const extraEvidence = await readLinkedWorkflowEvidence(extraProject, "snapshot-extra-generation");
  assert.equal(extraEvidence.ok, false);
  if (!extraEvidence.ok) {
    assert.equal(extraEvidence.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
    assert.match(extraEvidence.diagnostics[0]?.message ?? "", /unexpected generation/u);
  }

  const sealProject = tempProject();
  initProject({ projectRoot: sealProject, force: true });
  writeSmallTopology(sealProject);
  const sealedRun = await startRun({
    projectRoot: sealProject,
    runId: "snapshot-malformed-seal",
    env: fakeSmithersEnv(sealProject)
  });
  assert.equal(sealedRun.ok, true, JSON.stringify(sealedRun.diagnostics));
  const integrityPath = path.join(sealedRun.value!.run_root, "smithers", "control-integrity.json");
  const integrity = JSON.parse(fs.readFileSync(integrityPath, "utf8")) as Record<string, unknown>;
  integrity.unexpected_key = true;
  fs.writeFileSync(integrityPath, `${JSON.stringify(integrity, null, 2)}\n`, "utf8");
  const malformedEvidence = await readLinkedWorkflowEvidence(sealProject, "snapshot-malformed-seal");
  assert.equal(malformedEvidence.ok, false);
  if (!malformedEvidence.ok) {
    assert.equal(malformedEvidence.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
    assert.match(malformedEvidence.diagnostics[0]?.message ?? "", /seal is invalid/u);
  }
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
  ) as { run_id?: unknown; tasks?: Array<{ prompt?: string; prompt_path?: string }> };
  assert.equal(smithersInput.run_id, undefined);
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
  const executedAsLogPath = path.join(project, "local-smithers-executed-as.log");
  const installed = writeFakeInstalledSmithers(project);

  const run = await startRun({
    projectRoot: project,
    runId: "local-smithers-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: logPath, SMITHERS_FAKE_EXECUTED_AS_LOG: executedAsLogPath }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(logPath, "utf8"), /up .*ultrafuzz-local-smithers-run\.tsx/);
  const executedAs = fs.readFileSync(executedAsLogPath, "utf8").trim();
  if (process.platform !== "win32" && fs.existsSync("/proc/self/fd")) {
    assert.match(executedAs, /^\/proc\/\d+\/fd\/\d+$/u);
  } else {
    assert.equal(executedAs, fs.realpathSync(installed.target));
  }
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
  // These anchors are intentionally verified but not rewritten. A fabricated
  // compatibility tree must carry them so the fixture exercises the same
  // preconditions as the pinned installation.
  const { SMITHERS_REQUIRED_ENGINE_ANCHORS } = await import("../src/smithers.js");
  for (const required of SMITHERS_REQUIRED_ENGINE_ANCHORS) {
    const source = path.join(
      nodeModules,
      ...required.packageName.split("/"),
      ...required.sourceRelativePath.split("/")
    );
    bySource.set(source, [...(bySource.get(source) ?? []), required.anchor]);
  }
  for (const [source, anchors] of bySource) {
    fs.mkdirSync(path.dirname(source), { recursive: true });
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

test(
  "the patched runner admits engine and supervisor process-owned execution snapshot descriptors",
  { skip: process.platform === "win32" || !fs.existsSync("/proc/self/fd") },
  async () => {
    const { SMITHERS_COMPATIBILITY_PATCHES } = await import("../src/smithers.js");
    const descriptorPatch = SMITHERS_COMPATIBILITY_PATCHES.find((patch) => patch.id === "process_snapshot_anchor");
    const supervisorPatch = SMITHERS_COMPATIBILITY_PATCHES.find((patch) => patch.id === "supervisor_descriptor");
    assert.ok(descriptorPatch, "the process snapshot anchor compatibility patch is missing");
    assert.ok(supervisorPatch, "the supervisor descriptor compatibility patch is missing");

    const root = tempProject();
    const controlsDirectory = path.join(root, "controls");
    const workflowDirectory = path.join(root, ".smithers", "workflows");
    const configPath = path.join(controlsDirectory, "ultrafuzz.toml");
    const workflowPath = path.join(workflowDirectory, "detached-anchor.tsx");
    const scriptPath = path.join(root, "descriptor-chain.mjs");
    const logPath = path.join(root, "detached.log");
    const readyPath = path.join(root, "detached-ready.json");
    const engineReadyPath = path.join(root, "engine-ready.json");
    const supervisorReadyPath = path.join(root, "supervisor-ready.json");
    const goPath = path.join(root, "controller-descriptor-reused");
    const engineResultPath = path.join(root, "engine-result.json");
    const supervisorResultPath = path.join(root, "supervisor-result.json");
    const replacementPath = path.join(root, "replacement.txt");
    fs.mkdirSync(controlsDirectory, { recursive: true });
    fs.mkdirSync(workflowDirectory, { recursive: true });
    fs.writeFileSync(configPath, "sealed-config\n", "utf8");
    fs.writeFileSync(workflowPath, "sealed-workflow\n", "utf8");
    fs.writeFileSync(replacementPath, "not-a-directory\n", "utf8");
    fs.writeFileSync(
      scriptPath,
      `import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function detachedAdmissionMarker(nonce) {
  return "SMITHERS_DETACHED_ADMISSION=run:" + nonce;
}

async function waitForDetachedAdmission({ child, logFile, nonce, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tail = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    if (tail.includes(detachedAdmissionMarker(nonce))) return { admitted: true, tail };
    if (child.exitCode !== null || child.signalCode !== null) {
      return { admitted: false, reason: "supervisor exited before snapshot admission", tail };
    }
    if (Date.now() >= deadline) {
      return { admitted: false, reason: "supervisor snapshot admission timed out", tail };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function terminateUnadmittedChild(child) {
  try { child.kill("SIGKILL"); } catch {}
}

${descriptorPatch.patched}

const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const sleep = (milliseconds) => Atomics.wait(sleepArray, 0, 0, milliseconds);

async function launchSupervisor(child, logFile, workflowArgument) {
  const cliPath = process.argv[1];
  const supervisorArgs = [cliPath, "supervisor", workflowArgument];
  let supervisorPid;
  const fail = (failure) => ({ failure });
${supervisorPatch.patched}
  return { supervisorPid };
}

const phase = process.argv[2];
const workflowArgument = process.argv[3];
if (phase === "parent") {
  process.env.UFZ_DESCRIPTOR_PARENT_PID = String(process.pid);
  const child = spawn(process.execPath, [process.argv[1], "engine", workflowArgument], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
    }
  });
  child.unref();
  let deadline = Date.now() + 5_000;
  while (!existsSync(process.env.UFZ_DESCRIPTOR_ENGINE_READY_PATH) && Date.now() < deadline) sleep(10);
  if (!existsSync(process.env.UFZ_DESCRIPTOR_ENGINE_READY_PATH)) process.exit(81);

  const supervisorLaunch = await launchSupervisor(child, process.env.UFZ_DESCRIPTOR_LOG_PATH, workflowArgument);
  if (supervisorLaunch.failure || supervisorLaunch.supervisorPid === undefined) process.exit(82);
  deadline = Date.now() + 5_000;
  while (!existsSync(process.env.UFZ_DESCRIPTOR_SUPERVISOR_READY_PATH) && Date.now() < deadline) sleep(10);
  if (!existsSync(process.env.UFZ_DESCRIPTOR_SUPERVISOR_READY_PATH)) process.exit(83);
  writeFileSync(
    process.env.UFZ_DESCRIPTOR_READY_PATH,
    JSON.stringify({
      launcher_pid: process.pid,
      engine: JSON.parse(readFileSync(process.env.UFZ_DESCRIPTOR_ENGINE_READY_PATH, "utf8")),
      supervisor: JSON.parse(readFileSync(process.env.UFZ_DESCRIPTOR_SUPERVISOR_READY_PATH, "utf8"))
    })
  );
  process.exit(0);
}

if (phase === "engine" || phase === "supervisor") {
  const readyPath = phase === "engine"
    ? process.env.UFZ_DESCRIPTOR_ENGINE_READY_PATH
    : process.env.UFZ_DESCRIPTOR_SUPERVISOR_READY_PATH;
  const resultPath = phase === "engine"
    ? process.env.UFZ_DESCRIPTOR_ENGINE_RESULT_PATH
    : process.env.UFZ_DESCRIPTOR_SUPERVISOR_RESULT_PATH;
  writeFileSync(
    readyPath,
    JSON.stringify({
      pid: process.pid,
      config_path: process.env.ULTRAFUZZ_CONFIG_PATH,
      workflow_path: workflowArgument
    })
  );
  const parentPid = Number(process.env.UFZ_DESCRIPTOR_PARENT_PID);
  const deadline = Date.now() + 5_000;
  for (;;) {
    let parentAlive = true;
    try { process.kill(parentPid, 0); } catch { parentAlive = false; }
    if (!parentAlive && existsSync(process.env.UFZ_DESCRIPTOR_GO_PATH)) break;
    if (Date.now() >= deadline) {
      writeFileSync(resultPath, JSON.stringify({ error: "handoff-timeout" }));
      process.exit(84);
    }
    sleep(10);
  }
  try {
    writeFileSync(
      resultPath,
      JSON.stringify({
        phase,
        pid: process.pid,
        config_path: process.env.ULTRAFUZZ_CONFIG_PATH,
        workflow_path: workflowArgument,
        config: readFileSync(process.env.ULTRAFUZZ_CONFIG_PATH, "utf8"),
        workflow: readFileSync(workflowArgument, "utf8")
      })
    );
  } catch (error) {
    writeFileSync(
      resultPath,
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    );
    process.exit(85);
  }
}
`,
      "utf8"
    );

    const sourceDescriptor = fs.openSync(
      root,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
    );
    let replacementDescriptor: number | undefined;
    const detachedPids: number[] = [];
    try {
      const controllerRoot = `/proc/${process.pid}/fd/${sourceDescriptor}`;
      const parent = spawnSync(
        process.execPath,
        [scriptPath, "parent", path.join(controllerRoot, ".smithers", "workflows", path.basename(workflowPath))],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            ULTRAFUZZ_CONFIG_PATH: path.join(controllerRoot, "controls", "ultrafuzz.toml"),
            ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: workflowPath,
            UFZ_DESCRIPTOR_LOG_PATH: logPath,
            UFZ_DESCRIPTOR_READY_PATH: readyPath,
            UFZ_DESCRIPTOR_ENGINE_READY_PATH: engineReadyPath,
            UFZ_DESCRIPTOR_SUPERVISOR_READY_PATH: supervisorReadyPath,
            UFZ_DESCRIPTOR_GO_PATH: goPath,
            UFZ_DESCRIPTOR_ENGINE_RESULT_PATH: engineResultPath,
            UFZ_DESCRIPTOR_SUPERVISOR_RESULT_PATH: supervisorResultPath
          }
        }
      );
      assert.equal(parent.status, 0, parent.stderr);
      const ready = JSON.parse(fs.readFileSync(readyPath, "utf8")) as {
        launcher_pid?: number;
        engine?: { pid?: number; config_path?: string; workflow_path?: string };
        supervisor?: { pid?: number; config_path?: string; workflow_path?: string };
      };
      for (const processReady of [ready.engine, ready.supervisor]) {
        assert.equal(typeof processReady?.pid, "number");
        detachedPids.push(processReady!.pid!);
        assert.match(
          processReady?.config_path ?? "",
          new RegExp(`^/proc/${processReady!.pid}/fd/\\d+/controls/ultrafuzz\\.toml$`, "u")
        );
        assert.match(
          processReady?.workflow_path ?? "",
          new RegExp(`^/proc/${processReady!.pid}/fd/\\d+/.smithers/workflows/`, "u")
        );
        assert.doesNotMatch(
          processReady?.config_path ?? "",
          new RegExp(`^/proc/${process.pid}/fd/${sourceDescriptor}/`, "u")
        );
        assert.doesNotMatch(processReady?.config_path ?? "", new RegExp(`^/proc/${ready.launcher_pid}/fd/`, "u"));
      }
      assert.notEqual(ready.engine?.pid, ready.supervisor?.pid);

      fs.closeSync(sourceDescriptor);
      replacementDescriptor = fs.openSync(replacementPath, fs.constants.O_RDONLY);
      assert.equal(replacementDescriptor, sourceDescriptor, "the controller descriptor was not reused by the fixture");
      fs.writeFileSync(goPath, "go\n", "utf8");

      const deadline = Date.now() + 5_000;
      while ((!fs.existsSync(engineResultPath) || !fs.existsSync(supervisorResultPath)) && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      for (const resultPath of [engineResultPath, supervisorResultPath]) {
        assert.equal(fs.existsSync(resultPath), true, `${path.basename(resultPath)} was not published`);
        const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
          error?: string;
          config?: string;
          workflow?: string;
        };
        assert.equal(result.error, undefined);
        assert.equal(result.config, "sealed-config\n");
        assert.equal(result.workflow, "sealed-workflow\n");
      }
    } finally {
      if (replacementDescriptor !== undefined) fs.closeSync(replacementDescriptor);
      else {
        try {
          fs.closeSync(sourceDescriptor);
        } catch {
          // The descriptor was already closed before a later assertion failed.
        }
      }
      for (const detachedPid of detachedPids) {
        try {
          process.kill(detachedPid, "SIGKILL");
        } catch {
          // The detached fixture normally exits before cleanup.
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "fixed fd transfer survives launcher and supervisor reuse before stable-path resumes start",
  { skip: process.platform === "win32" || !fs.existsSync("/proc/self/fd") },
  async () => {
    const { SMITHERS_COMPATIBILITY_PATCHES } = await import("../src/smithers.js");
    const descriptorPatch = SMITHERS_COMPATIBILITY_PATCHES.find((patch) => patch.id === "process_snapshot_anchor");
    const detachedTransferPatch = SMITHERS_COMPATIBILITY_PATCHES.find(
      (patch) => patch.id === "detached_snapshot_transfer"
    );
    const supervisorPatch = SMITHERS_COMPATIBILITY_PATCHES.find((patch) => patch.id === "supervisor_descriptor");
    const resumeTransferPatch = SMITHERS_COMPATIBILITY_PATCHES.find((patch) => patch.id === "resume_snapshot_transfer");
    assert.ok(descriptorPatch);
    assert.ok(detachedTransferPatch);
    assert.ok(supervisorPatch);
    assert.ok(resumeTransferPatch);

    const root = tempProject();
    const coordinationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-snapshot-transfer-"));
    const workflowPath = path.join(root, ".smithers", "workflows", "fd-transfer.tsx");
    const configPath = path.join(root, "controls", "ultrafuzz.toml");
    const scriptPath = path.join(root, "descriptor-generations.mjs");
    const logPath = path.join(coordinationRoot, "detached.log");
    const launcherRecordPath = path.join(coordinationRoot, "launcher.json");
    const supervisorRecordPath = path.join(coordinationRoot, "supervisor.json");
    const resumeLaunchPath = path.join(coordinationRoot, "resume-launch.json");
    const engineResultPath = path.join(coordinationRoot, "engine.json");
    const loggedResumeResultPath = path.join(coordinationRoot, "resume-logged.json");
    const ignoredResumeResultPath = path.join(coordinationRoot, "resume-ignored.json");
    const goPath = path.join(coordinationRoot, "go");
    const replacementPath = path.join(coordinationRoot, "replacement.txt");
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(workflowPath, "sealed-workflow\n", "utf8");
    fs.writeFileSync(configPath, "sealed-config\n", "utf8");
    fs.writeFileSync(replacementPath, "regular-file-replacement\n", "utf8");
    fs.writeFileSync(
      scriptPath,
      `import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

${descriptorPatch.patched}

const DETACHED_RUN_LOG_FILE_ENV = "SMITHERS_DETACHED_RUN_LOG_FILE";
const DETACHED_ADMISSION_NONCE_ENV = "SMITHERS_DETACHED_ADMISSION_NONCE";
const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const sleep = (milliseconds) => Atomics.wait(sleepArray, 0, 0, milliseconds);

function evidence(workflowArgument) {
  return {
    pid: process.pid,
    parent_pid: process.ppid,
    process_descriptor: Number(process.env.ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR),
    process_root: process.env.ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT,
    persisted_root: process.env.ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT,
    inherited_descriptor_present: Object.prototype.hasOwnProperty.call(
      process.env,
      "ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR"
    ),
    config_path: process.env.ULTRAFUZZ_CONFIG_PATH,
    workflow_path: workflowArgument,
    monitor_suppressed: process.env.SMITHERS_MONITOR_SUPPRESS,
    autopsy_suppressed: process.env.SMITHERS_POST_FAILURE
  };
}

function closeAndReuseProcessDescriptor() {
  const descriptor = Number(process.env.ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR);
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) throw new Error("missing process descriptor");
  closeSync(descriptor);
  const replacements = [];
  for (let index = 0; index < 256; index += 1) {
    const replacement = openSync(process.env.UFZ_REPLACEMENT_PATH, "r");
    replacements.push(replacement);
    if (replacement === descriptor) return descriptor;
    if (replacement > descriptor) break;
  }
  throw new Error("could not reuse process descriptor " + descriptor);
}

function launchEngine(workflowArgument) {
  const cliPath = process.argv[1];
  const childArgs = ["engine", workflowArgument];
  const admissionNonce = "fixture-engine";
  const logFile = process.env.UFZ_LOG_PATH;
  const fd = openSync(logFile, "a");
  let child;
  try {
${detachedTransferPatch.patched}
  } finally {
    closeSync(fd);
  }
  child.unref();
  return child.pid;
}

function launchSupervisor() {
  const supervisorArgs = [process.argv[1], "supervisor"];
  const logFile = process.env.UFZ_LOG_PATH;
  let supervisorPid;
${supervisorPatch.patched}
  return supervisorPid;
}

function launchResume(phase, withLog) {
  const stableRoot = process.env.ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT;
  const args = [resolve(stableRoot, "descriptor-generations.mjs"), phase, process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH];
  const cwd = process.cwd();
  const logFd = withLog ? openSync(process.env.UFZ_LOG_PATH, "a") : null;
  try {
${resumeTransferPatch.patched}
    child.unref();
    return { pid: child.pid, args };
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
}

const phase = process.argv[2];
const workflowArgument = process.argv[3];
if (phase === "probe-anchor") {
  process.stdout.write(JSON.stringify(evidence(workflowArgument)));
  process.exit(0);
}

if (phase === "reject-partial-engine") {
  delete process.env.ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT;
  try {
    launchEngine(workflowArgument);
  } catch (error) {
    process.stdout.write(error instanceof Error ? error.message : String(error));
    process.exit(0);
  }
  process.exit(90);
}

if (phase === "reject-malformed-supervisor") {
  process.env.ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR = "   ";
  try {
    launchSupervisor();
  } catch (error) {
    process.stdout.write(error instanceof Error ? error.message : String(error));
    process.exit(0);
  }
  process.exit(91);
}

if (phase === "reject-partial-resume") {
  delete process.env.ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR;
  try {
    launchResume("resume-ignored", false);
  } catch (error) {
    process.stdout.write(error instanceof Error ? error.message : String(error));
    process.exit(0);
  }
  process.exit(92);
}

if (phase === "launcher") {
  process.env.UFZ_PARENT_PID = String(process.pid);
  const ownEvidence = evidence(workflowArgument);
  const enginePid = launchEngine(workflowArgument);
  const supervisorPid = launchSupervisor();
  const reusedDescriptor = closeAndReuseProcessDescriptor();
  writeFileSync(
    process.env.UFZ_LAUNCHER_RECORD_PATH,
    JSON.stringify({ ...ownEvidence, engine_pid: enginePid, supervisor_pid: supervisorPid, reused_descriptor: reusedDescriptor })
  );
  process.exit(0);
}

if (phase === "supervisor") {
  process.env.UFZ_PARENT_PID = String(process.pid);
  const ownEvidence = evidence(undefined);
  const logged = launchResume("resume-logged", true);
  const ignored = launchResume("resume-ignored", false);
  writeFileSync(process.env.UFZ_RESUME_LAUNCH_PATH, JSON.stringify({ logged: logged.args, ignored: ignored.args }));
  const reusedDescriptor = closeAndReuseProcessDescriptor();
  writeFileSync(
    process.env.UFZ_SUPERVISOR_RECORD_PATH,
    JSON.stringify({ ...ownEvidence, logged_pid: logged.pid, ignored_pid: ignored.pid, reused_descriptor: reusedDescriptor })
  );
  process.exit(0);
}

if (phase === "engine" || phase === "resume-logged" || phase === "resume-ignored") {
  const resultPath = phase === "engine"
    ? process.env.UFZ_ENGINE_RESULT_PATH
    : phase === "resume-logged"
      ? process.env.UFZ_LOGGED_RESUME_RESULT_PATH
      : process.env.UFZ_IGNORED_RESUME_RESULT_PATH;
  const parentPid = Number(process.env.UFZ_PARENT_PID);
  const deadline = Date.now() + 10_000;
  for (;;) {
    let parentAlive = true;
    try { process.kill(parentPid, 0); } catch { parentAlive = false; }
    if (!parentAlive && existsSync(process.env.UFZ_GO_PATH)) break;
    if (Date.now() >= deadline) {
      writeFileSync(resultPath, JSON.stringify({ error: "parent-handoff-timeout" }));
      process.exit(81);
    }
    sleep(10);
  }
  try {
    writeFileSync(
      resultPath,
      JSON.stringify({
        phase,
        ...evidence(workflowArgument),
        config: readFileSync(process.env.ULTRAFUZZ_CONFIG_PATH, "utf8"),
        workflow: readFileSync(workflowArgument, "utf8")
      })
    );
  } catch (error) {
    writeFileSync(resultPath, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exit(82);
  }
}
`,
      "utf8"
    );

    const sourceDescriptor = fs.openSync(
      root,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
    );
    let replacementDescriptor: number | undefined;
    const pids = new Set<number>();
    try {
      const controllerRoot = `/proc/${process.pid}/fd/${sourceDescriptor}`;
      const controllerWorkflowPath = path.join(controllerRoot, ".smithers", "workflows", path.basename(workflowPath));
      const fixtureEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        ULTRAFUZZ_CONFIG_PATH: path.join(controllerRoot, "controls", "ultrafuzz.toml"),
        ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: workflowPath,
        UFZ_LOG_PATH: logPath,
        UFZ_LAUNCHER_RECORD_PATH: launcherRecordPath,
        UFZ_SUPERVISOR_RECORD_PATH: supervisorRecordPath,
        UFZ_RESUME_LAUNCH_PATH: resumeLaunchPath,
        UFZ_ENGINE_RESULT_PATH: engineResultPath,
        UFZ_LOGGED_RESUME_RESULT_PATH: loggedResumeResultPath,
        UFZ_IGNORED_RESUME_RESULT_PATH: ignoredResumeResultPath,
        UFZ_GO_PATH: goPath,
        UFZ_REPLACEMENT_PATH: replacementPath
      };
      for (const name of [
        "ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR",
        "ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT",
        "ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR",
        "ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT"
      ]) {
        delete fixtureEnvironment[name];
      }

      for (const phase of ["reject-partial-engine", "reject-malformed-supervisor", "reject-partial-resume"]) {
        const rejected = spawnSync(process.execPath, [scriptPath, phase, controllerWorkflowPath], {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          env: fixtureEnvironment
        });
        assert.equal(rejected.status, 0, `${phase}: ${rejected.stderr}`);
        assert.match(rejected.stdout, /execution snapshot transfer capability/u, phase);
      }

      for (const inheritedDescriptor of ["invalid", "0", "4"]) {
        const rejected = spawnSync(process.execPath, [scriptPath, "probe-anchor", controllerWorkflowPath], {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "pipe", sourceDescriptor],
          env: {
            ...fixtureEnvironment,
            ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR: inheritedDescriptor
          }
        });
        assert.notEqual(rejected.status, 0, `inherited fd ${inheritedDescriptor} was accepted`);
        assert.match(rejected.stderr, /inherited execution snapshot descriptor must be fixed fd 3/u);
      }

      const anchoredProbe = spawnSync(process.execPath, [scriptPath, "probe-anchor", controllerWorkflowPath], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe", sourceDescriptor],
        env: {
          ...fixtureEnvironment,
          ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR: "3"
        }
      });
      assert.equal(anchoredProbe.status, 0, anchoredProbe.stderr);
      assertProcessOwnedSnapshotEvidence(JSON.parse(anchoredProbe.stdout) as TransferEvidence);

      const launcher = spawnSync(process.execPath, [scriptPath, "launcher", controllerWorkflowPath], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: fixtureEnvironment
      });
      assert.equal(launcher.status, 0, launcher.stderr);
      const launcherEvidence = readTransferEvidence(launcherRecordPath);
      assertProcessOwnedSnapshotEvidence(launcherEvidence);
      assert.equal(launcherEvidence.reused_descriptor, launcherEvidence.process_descriptor);
      addEvidencePids(pids, launcherEvidence, "engine_pid", "supervisor_pid");

      fs.closeSync(sourceDescriptor);
      replacementDescriptor = fs.openSync(replacementPath, fs.constants.O_RDONLY);
      assert.equal(replacementDescriptor, sourceDescriptor, "controller snapshot descriptor was not reused");
      fs.writeFileSync(goPath, "go\n", "utf8");

      const deadline = Date.now() + 10_000;
      const awaited = [
        supervisorRecordPath,
        resumeLaunchPath,
        engineResultPath,
        loggedResumeResultPath,
        ignoredResumeResultPath
      ];
      while (awaited.some((file) => !fs.existsSync(file)) && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      for (const file of awaited) assert.equal(fs.existsSync(file), true, `${path.basename(file)} was not published`);

      const supervisorEvidence = readTransferEvidence(supervisorRecordPath);
      assertProcessOwnedSnapshotEvidence(supervisorEvidence);
      assert.equal(supervisorEvidence.reused_descriptor, supervisorEvidence.process_descriptor);
      addEvidencePids(pids, supervisorEvidence, "logged_pid", "ignored_pid");

      const resumeLaunch = JSON.parse(fs.readFileSync(resumeLaunchPath, "utf8")) as {
        logged?: string[];
        ignored?: string[];
      };
      assert.deepEqual(resumeLaunch.logged, [scriptPath, "resume-logged", workflowPath]);
      assert.deepEqual(resumeLaunch.ignored, [scriptPath, "resume-ignored", workflowPath]);

      for (const resultPath of [engineResultPath, loggedResumeResultPath, ignoredResumeResultPath]) {
        const result = readTransferEvidence(resultPath);
        assert.equal(result.error, undefined);
        assertProcessOwnedSnapshotEvidence(result);
        assert.equal(result.config, "sealed-config\n");
        assert.equal(result.workflow, "sealed-workflow\n");
        assert.match(result.workflow_path ?? "", new RegExp(`^/proc/${result.pid}/fd/\\d+/.smithers/workflows/`, "u"));
        if (result.pid !== undefined) pids.add(result.pid);
      }
    } finally {
      if (replacementDescriptor !== undefined) fs.closeSync(replacementDescriptor);
      else {
        try {
          fs.closeSync(sourceDescriptor);
        } catch {
          // The descriptor was already closed before a later assertion failed.
        }
      }
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The detached fixtures normally exit before cleanup.
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(coordinationRoot, { recursive: true, force: true });
    }
  }
);

type TransferEvidence = {
  error?: string;
  pid?: number;
  process_descriptor?: number;
  process_root?: string;
  inherited_descriptor_present?: boolean;
  config_path?: string;
  workflow_path?: string;
  monitor_suppressed?: string;
  autopsy_suppressed?: string;
  reused_descriptor?: number;
  config?: string;
  workflow?: string;
  [key: string]: unknown;
};

function readTransferEvidence(file: string): TransferEvidence {
  return JSON.parse(fs.readFileSync(file, "utf8")) as TransferEvidence;
}

function assertProcessOwnedSnapshotEvidence(evidence: TransferEvidence): void {
  assert.equal(typeof evidence.pid, "number");
  assert.equal(typeof evidence.process_descriptor, "number");
  assert.equal(evidence.process_root, `/proc/${evidence.pid}/fd/${evidence.process_descriptor}`);
  assert.equal(evidence.inherited_descriptor_present, false);
  assert.match(
    evidence.config_path ?? "",
    new RegExp(`^/proc/${evidence.pid}/fd/\\d+/controls/ultrafuzz\\.toml$`, "u")
  );
  assert.equal(evidence.monitor_suppressed, "1");
  assert.equal(evidence.autopsy_suppressed, "0");
}

function addEvidencePids(pids: Set<number>, evidence: TransferEvidence, ...keys: string[]): void {
  if (evidence.pid !== undefined) pids.add(evidence.pid);
  for (const key of keys) {
    const value = evidence[key];
    if (typeof value === "number") pids.add(value);
  }
}

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

// R54 died 90 seconds in, before its first task node: npm resolved a transitive
// dependency to a version published two minutes earlier and 404ed on the tarball,
// which had not reached the registry CDN edge yet.
test("startRun retries a workflow runner install the registry fails transiently", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const installer = writeFakeNpmInstaller(project, {
    count: 1,
    stderr: [
      "npm error code E404",
      "npm error 404 Not Found - GET https://registry.npmjs.org/@ai-sdk/provider/-/provider-4.0.7.tgz - Not found"
    ]
  });

  const run = await startRun({
    projectRoot: project,
    runId: "transient-install-run",
    env: {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(installer.npmLogPath, "utf8").trimEnd().split("\n").length, 2);
  assert.match(fs.readFileSync(installer.smithersLogPath, "utf8"), /up .*ultrafuzz-transient-install-run\.tsx/);
});

test("startRun does not retry a workflow runner install the registry rejects permanently", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  // A 404 on a package name, not on a tarball URL: no amount of waiting publishes it.
  const installer = writeFakeNpmInstaller(project, {
    count: 4,
    stderr: [
      "npm error code E404",
      "npm error 404 Not Found - GET https://registry.npmjs.org/@ultrafuzz/does-not-exist - Not found"
    ]
  });

  const run = await startRun({
    projectRoot: project,
    runId: "permanent-install-run",
    env: {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, false);
  assert.equal(fs.readFileSync(installer.npmLogPath, "utf8").trimEnd().split("\n").length, 1);
});

test("isTransientNpmRegistryFailure separates a waitable registry gap from a real dependency error", () => {
  const tarball404 = {
    code: 1,
    killed: false,
    stderr:
      "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@ai-sdk/provider/-/provider-4.0.7.tgz - Not found\n"
  };
  assert.equal(isTransientNpmRegistryFailure(tarball404), true);
  assert.equal(isTransientNpmRegistryFailure({ code: 1, stderr: "npm error network socket hang up\n" }), true);
  assert.equal(
    isTransientNpmRegistryFailure({ code: 1, stderr: "npm error 503 Service Unavailable - GET .../x.tgz\n" }),
    true
  );

  assert.equal(
    isTransientNpmRegistryFailure({
      code: 1,
      stderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope - Not found\n"
    }),
    false
  );
  assert.equal(
    isTransientNpmRegistryFailure({
      code: 1,
      stderr: "npm error code ERESOLVE\nnpm error ERESOLVE could not resolve\n"
    }),
    false
  );
  // An abort or a timeout kill is not the registry's doing, and the deadline that
  // stopped the install has already passed by the time a retry would start.
  assert.equal(isTransientNpmRegistryFailure({ killed: true, stderr: tarball404.stderr }), false);
  assert.equal(isTransientNpmRegistryFailure({ name: "AbortError", stderr: tarball404.stderr }), false);
  assert.equal(isTransientNpmRegistryFailure(undefined), false);
});

test("startRun resolves the generated workspace as of a fixed instant, not the launch clock", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const installer = writeFakeNpmInstaller(project);

  const run = await startRun({
    projectRoot: project,
    runId: "pinned-resolution-run",
    env: {
      PATH: `${installer.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  // Without `--before`, npm re-resolves every open range below the pins against
  // whatever the registry holds at that instant. R54 died at workflow submission
  // because that landed on `@ai-sdk/provider@4.0.7`, published 2m08s earlier and
  // not yet on the CDN edge the container reached.
  const npmLog = fs.readFileSync(installer.npmLogPath, "utf8");
  assert.equal(npmLog.includes(`--before=${SMITHERS_DEPENDENCY_RESOLUTION_CUTOFF} `), true, npmLog);
});

test("both installers of the generated workspace share one resolution cutoff", () => {
  const local = smithersDependencyInstallArgs({
    prefix: "/tmp/local/.smithers",
    registry: "https://registry.npmjs.org"
  });
  const cloud = smithersDependencyInstallArgs({ prefix: "/tmp/cloud/.smithers" });

  for (const args of [local, cloud]) {
    assert.equal(args.includes(`--before=${SMITHERS_DEPENDENCY_RESOLUTION_CUTOFF}`), true, args.join(" "));
    // The cutoff makes resolution reproducible; it does not relax the hardening
    // the install already carried, and it must not introduce a lockfile into the
    // run workspace that an in-flight resume would then have to reconcile.
    assert.equal(args.includes("--ignore-scripts"), true, args.join(" "));
    assert.equal(args.includes("--package-lock=false"), true, args.join(" "));
  }
  // The cloud node worker installs against the sandbox's ambient npm
  // configuration, so it must not be handed the local path's registry.
  assert.equal(local.includes("--registry=https://registry.npmjs.org"), true, local.join(" "));
  assert.equal(
    cloud.some((arg) => arg.startsWith("--registry=")),
    false,
    cloud.join(" ")
  );
});

test("the resolution cutoff cannot fall behind a pinned dependency", () => {
  // Guards the rule rather than one more package name: a pin raised without
  // moving the cutoff past its publish instant would leave `--before` unable to
  // see the very version the manifest demands.
  assertSmithersResolutionCutoff();
  assert.equal(Date.parse(SMITHERS_DEPENDENCY_RESOLUTION_CUTOFF) < Date.now(), true);
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
  writeFakeInstalledSmithersDependency(project, "custom-agent-package", "1.2.3");
  const installer = writeFakeNpmInstaller(project);

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
  writeFakeInstalledSmithersDependency(project, "custom-agent-package", "1.2.3");
  const installer = writeFakeNpmInstaller(project);

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
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SMITHERS_BIN: smithers }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.existsSync(path.join(run.value!.run_root, "smithers", "logs")), true);
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
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SMITHERS_BIN: smithers }
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

// Findings normalization rewrites findings.json in place, stamping the provenance the producer
// omitted. The workflow verifier has already sealed the pre-normalization bytes into this attempt's
// verification marker, and every dependent re-hashes the published file against that marker in
// `assertVerifiedDependency`. A marker left describing bytes that no longer exist fails each
// dependent's `prepare:` wrapper as `artifact-contract` before its agent runs -- which is exactly
// what kept `dedupe-findings`, the only smoke-lane node whose dependencies publish findings.json,
// red on all three targets in every toolchain (issue #348). The drift is not confined to producers
// that reported findings: `writeJsonDurable` re-serializes with two-space indent and a trailing
// newline, so even `[]` moves unless the producer already wrote exactly `[]\n`. What kept this
// hidden is that no fixture drove normalization and a sealed marker together.
test("syncRun re-seals the verification marker after it normalizes a producer's findings", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-findings-marker";
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
  const run = await startRun({ projectRoot: project, runId: "sync-findings-marker", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const runRoot = run.value!.run_root;
  writeRequiredArtifactSet(runRoot, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const findingsPath = path.join(runRoot, "artifacts", "project-discovery", "findings.json");
  const markdownPath = path.join(runRoot, "artifacts", "project-discovery", "setup", "project-discovery.md");
  const sha = (filePath: string): string => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  // Exactly what the generated workflow's verifier publishes once the agent task succeeds.
  const sealedFindings = sha(findingsPath);
  const sealedMarkdown = sha(markdownPath);
  const markerDir = path.join(runRoot, ".ultrafuzz-verification");
  fs.mkdirSync(markerDir, { recursive: true });
  const markerPath = path.join(markerDir, "project-discovery.json");
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify({
      schema_version: "ultrafuzz.artifact-verification.v1",
      attempt_id: "project-discovery",
      node_id: "project-discovery",
      artifacts: [
        {
          path: "setup/project-discovery.md",
          contract: "ultrafuzz/nonempty-markdown@1",
          contract_digest: "a".repeat(64),
          sha256: sealedMarkdown,
          primary: true
        },
        {
          path: "findings.json",
          contract: "ultrafuzz/findings@1",
          contract_digest: "b".repeat(64),
          sha256: sealedFindings,
          primary: false
        }
      ],
      publications: [
        { path: "setup/project-discovery.md", sha256: sealedMarkdown },
        { path: "findings.json", sha256: sealedFindings }
      ]
    })}\n`,
    "utf8"
  );

  const sync = await syncRun({ projectRoot: project, runId: "sync-findings-marker", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));

  const normalizedFindings = sha(findingsPath);
  assert.notEqual(normalizedFindings, sealedFindings, "normalization did not actually rewrite findings.json");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
    artifacts: Array<{ path: string; sha256: string; contract?: string; contract_digest?: string; primary?: boolean }>;
    publications: Array<{ path: string; sha256: string }>;
  };
  // Both sets a dependent re-checks now attest the bytes on disk.
  for (const entries of [marker.artifacts, marker.publications]) {
    assert.equal(entries.find((entry) => entry.path === "findings.json")?.sha256, normalizedFindings);
    // Nothing the runtime did not rewrite may move.
    assert.equal(entries.find((entry) => entry.path === "setup/project-discovery.md")?.sha256, sealedMarkdown);
  }
  const findingsArtifact = marker.artifacts.find((entry) => entry.path === "findings.json");
  assert.equal(findingsArtifact?.contract, "ultrafuzz/findings@1");
  assert.equal(findingsArtifact?.contract_digest, "b".repeat(64));
  assert.equal(findingsArtifact?.primary, false);
  // Re-sealing an attestation is a security-relevant edit, so it is recorded rather than silent.
  const refreshed = sync.diagnostics.find((diagnostic) => diagnostic.code === "ARTIFACT_VERIFICATION_DIGEST_REFRESHED");
  assert.ok(refreshed, JSON.stringify(sync.diagnostics));
  assert.equal(refreshed.severity, "warning");
  assert.equal(refreshed.source, "findings");
  assert.deepEqual((refreshed.details as { previous_sha256?: string[] }).previous_sha256, [sealedFindings]);
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
  assert.deepEqual(state.nodes?.["project-discovery"]?.provenance?.terminal_disposition, {
    schema_version: "ultrafuzz.terminal-disposition.v1",
    kind: "task-output-validation-failure"
  });
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
});

test("syncRun surfaces a terminal preparation wrapper failure as a failed durable node", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project);
  const workflowRunId = "ultrafuzz-sync-preparation-failure";
  const preparationError =
    "artifact-contract failure: artifact dependency has not passed verification project-discovery for actors-flows";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      error: { message: "Task failed: prepare:actors-flows" },
      failedChildKeys: ["prepare:actors-flows::0"],
      steps: [
        { id: "node:project-discovery", state: "finished", attempt: 1 },
        { id: "prepare:actors-flows", state: "failed", attempt: 1 },
        { id: "node:actors-flows", state: "pending" }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "prepare:actors-flows", attempt: 1 },
      { type: "NodeFailed", nodeId: "prepare:actors-flows", attempt: 1, error: { message: preparationError } },
      { type: "RunFailed" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-preparation-failure", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-preparation-failure", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    status?: string;
    nodes?: Record<
      string,
      { status?: string; last_error?: string; provenance?: Record<string, Record<string, unknown>> }
    >;
  };
  assert.equal(state.nodes?.["project-discovery"]?.status, "succeeded");
  // The stall signature this regression guards: a terminal failed workflow that
  // leaves every durable node non-terminal, so nothing is resettable.
  assert.ok(
    Object.values(state.nodes ?? {}).some((node) => node.status === "failed"),
    `terminal failed run recorded no failed node: ${JSON.stringify(state.nodes)}`
  );
  const dependent = state.nodes?.["actors-flows"];
  assert.equal(dependent?.status, "failed");
  assert.match(String(dependent?.last_error), /artifact dependency has not passed verification/u);
  assert.equal(dependent?.provenance?.workflow?.task_id, "prepare:actors-flows");
  assert.equal(dependent?.provenance?.workflow?.agent_task_id, "node:actors-flows");
  assert.equal(dependent?.provenance?.failure?.category, "artifact-contract");
  assert.equal(dependent?.provenance?.failure?.causal_task_id, "prepare:actors-flows");
  const events = fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8");
  assert.match(events, /"workflow_task_id":"prepare:actors-flows"/u);
});

test("syncRun keeps a preparation failure superseded by a later successful attempt", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project);
  const workflowRunId = "ultrafuzz-sync-preparation-recovered";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [
        { id: "node:project-discovery", state: "finished", attempt: 1 },
        { id: "prepare:actors-flows", state: "finished", attempt: 2 },
        { id: "node:actors-flows", state: "finished", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFailed", nodeId: "prepare:actors-flows", attempt: 1, error: { message: "transient failure" } },
      { type: "NodeFinished", nodeId: "prepare:actors-flows", attempt: 2 },
      { type: "NodeFinished", nodeId: "node:actors-flows", attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-preparation-recovered", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md"]);
  writeRequiredArtifactSet(run.value!.run_root, "actors-flows", ["setup/actors-flows.md"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-preparation-recovered", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.nodes?.["actors-flows"]?.status, "succeeded");
});

test("syncRun reports a typed diagnostic when a terminal workflow failure has no failed durable node", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-unattributed-failure";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      error: { message: "Task failed: ultrafuzz-agent-tasks" },
      failedChildKeys: ["ultrafuzz-agent-tasks::0"],
      steps: [{ id: "node:project-discovery", state: "pending" }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodePending", nodeId: "node:project-discovery" },
      { type: "RunFailed" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-unattributed-failure", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-unattributed-failure", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  const diagnostic = sync.diagnostics.find((candidate) => candidate.code === "WORKFLOW_TERMINAL_WITHOUT_FAILED_NODE");
  assert.ok(diagnostic, `expected a typed diagnostic, got ${JSON.stringify(sync.diagnostics)}`);
  assert.equal(diagnostic?.severity, "error");
  assert.deepEqual(diagnostic?.details?.failed_workflow_tasks, ["ultrafuzz-agent-tasks"]);
  assert.equal(diagnostic?.details?.workflow_state, "failed");
});

test("syncRun records an unattributed terminal workflow failure durably and only once", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-unattributed-durable";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      error: { message: "Task failed: ultrafuzz-agent-tasks" },
      failedChildKeys: ["ultrafuzz-agent-tasks::0"],
      steps: [{ id: "node:project-discovery", state: "pending" }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodePending", nodeId: "node:project-discovery" },
      { type: "RunFailed" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-unattributed-durable", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const first = await syncRun({ projectRoot: project, runId: "sync-unattributed-durable", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));

  // The diagnostic alone is discarded by both automated consumers (the eval
  // runner drops diagnostics when ok, the Modal worker drains child stdout), so
  // the archived run root has to carry the record itself.
  const eventsPath = path.join(run.value!.run_root, "events.jsonl");
  const recorded = (): Array<{ event_type?: string; payload?: Record<string, unknown> }> =>
    fs
      .readFileSync(eventsPath, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { event_type?: string; payload?: Record<string, unknown> })
      .filter((event) => event.event_type === "workflow-failure-unattributed");
  assert.equal(recorded().length, 1, `expected one durable record, got ${JSON.stringify(recorded())}`);
  assert.deepEqual(recorded()[0]?.payload?.failed_workflow_tasks, ["ultrafuzz-agent-tasks"]);
  assert.equal(recorded()[0]?.payload?.workflow_run_id, workflowRunId);
  assert.equal(recorded()[0]?.payload?.workflow_state, "failed");
  // Ids only: no error text may reach the durable record.
  assert.equal(JSON.stringify(recorded()[0]?.payload).includes("Task failed"), false);

  // Sync runs on every status/inspect, so a re-observed terminal failure must
  // not append a second identical record.
  const second = await syncRun({ projectRoot: project, runId: "sync-unattributed-durable", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  assert.equal(recorded().length, 1, `the record must not be re-appended: ${JSON.stringify(recorded())}`);
});

test("syncRun leaves a cancelled preparation wrapper unattributed", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project);
  const workflowRunId = "ultrafuzz-sync-preparation-cancelled";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "canceled",
      state: "canceled",
      steps: [
        { id: "node:project-discovery", state: "finished", attempt: 1 },
        { id: "prepare:actors-flows", state: "canceled", attempt: 1 },
        { id: "node:actors-flows", state: "pending" }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeStarted", nodeId: "prepare:actors-flows", attempt: 1 },
      { type: "NodeCancelled", nodeId: "prepare:actors-flows", attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-preparation-cancelled", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-preparation-cancelled", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; provenance?: Record<string, Record<string, unknown>> }>;
  };
  // The deadline path's own requestSmithersCancel reaches this shape, so a
  // cancellation must never be published as an artifact-contract violation of a
  // node that provably never ran.
  assert.equal(
    state.nodes?.["actors-flows"]?.status,
    "pending",
    `a cancelled wrapper must not finalize the node it gates: ${JSON.stringify(state.nodes?.["actors-flows"])}`
  );
  assert.equal(state.nodes?.["actors-flows"]?.provenance?.failure, undefined);
  assert.equal(
    sync.diagnostics.some((candidate) => candidate.code === "ARTIFACT_PREPARATION_FAILED"),
    false,
    JSON.stringify(sync.diagnostics)
  );
});

test("syncRun clears a preparation failure attribution once the node succeeds", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project);
  const workflowRunId = "ultrafuzz-sync-preparation-cleared";
  const failingEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      error: { message: "Task failed: prepare:actors-flows" },
      failedChildKeys: ["prepare:actors-flows::0"],
      steps: [
        { id: "node:project-discovery", state: "finished", attempt: 1 },
        { id: "prepare:actors-flows", state: "failed", attempt: 1 },
        { id: "node:actors-flows", state: "pending" }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFailed", nodeId: "prepare:actors-flows", attempt: 1, error: { message: "prepare exploded" } },
      { type: "RunFailed" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-preparation-cleared", env: failingEnv });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md"]);

  const failed = await syncRun({ projectRoot: project, runId: "sync-preparation-cleared", env: failingEnv });
  assert.equal(failed.ok, true, JSON.stringify(failed.diagnostics));
  const failedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; provenance?: Record<string, Record<string, unknown>> }>;
  };
  assert.equal(failedState.nodes?.["actors-flows"]?.status, "failed");
  assert.equal(failedState.nodes?.["actors-flows"]?.provenance?.failure?.causal_task_id, "prepare:actors-flows");

  // `--retry-failed` resets the failed wrapper off failedChildKeys, so prepare
  // re-runs and the node succeeds. This is the intended recovery for #272.
  writeRequiredArtifactSet(run.value!.run_root, "actors-flows", ["setup/actors-flows.md"]);
  const recoveredEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [
        { id: "node:project-discovery", state: "finished", attempt: 1 },
        { id: "prepare:actors-flows", state: "finished", attempt: 2 },
        { id: "node:actors-flows", state: "finished", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFinished", nodeId: "prepare:actors-flows", attempt: 2 },
      { type: "NodeFinished", nodeId: "node:actors-flows", attempt: 1 }
    ])
  });

  const recovered = await syncRun({ projectRoot: project, runId: "sync-preparation-cleared", env: recoveredEnv });

  assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
  const recoveredState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; provenance?: Record<string, Record<string, unknown>> }>;
  };
  assert.equal(recoveredState.nodes?.["actors-flows"]?.status, "succeeded");
  // dependencyCascadeFailure returns the first dependency carrying a `failure`
  // record, so a stale one re-attributes every later skipped dependent to
  // prepare:<attemptId> / artifact-contract and ships that in the eval row.
  assert.equal(
    recoveredState.nodes?.["actors-flows"]?.provenance?.failure,
    undefined,
    `a recovered node must not keep its failure attribution: ${JSON.stringify(
      recoveredState.nodes?.["actors-flows"]?.provenance
    )}`
  );
});

test("syncRun does not report an unattributed failure that state.json already attributes", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project);
  const workflowRunId = "ultrafuzz-sync-attribution-durable";
  const attributingEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      error: { message: "Task failed: prepare:actors-flows" },
      failedChildKeys: ["prepare:actors-flows::0"],
      steps: [
        { id: "node:project-discovery", state: "finished", attempt: 1 },
        { id: "prepare:actors-flows", state: "failed", attempt: 1 },
        { id: "node:actors-flows", state: "pending" }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFailed", nodeId: "prepare:actors-flows", attempt: 1, error: { message: "prepare exploded" } },
      { type: "RunFailed" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-attribution-durable", env: attributingEnv });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md"]);
  const attributed = await syncRun({ projectRoot: project, runId: "sync-attribution-durable", env: attributingEnv });
  assert.equal(attributed.ok, true, JSON.stringify(attributed.diagnostics));

  // A later resume where the wrapper's evidence is no longer synchronizable:
  // the in-pass status map never records actors-flows, but state.json does.
  const forgetfulEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      error: { message: "Task failed: prepare:actors-flows" },
      failedChildKeys: ["prepare:actors-flows::0"],
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [{ type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 }])
  });

  const resumed = await syncRun({ projectRoot: project, runId: "sync-attribution-durable", env: forgetfulEnv });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.nodes?.["actors-flows"]?.status, "failed");
  assert.equal(
    resumed.diagnostics.some((candidate) => candidate.code === "WORKFLOW_TERMINAL_WITHOUT_FAILED_NODE"),
    false,
    `the durable attribution must suppress the backstop: ${JSON.stringify(resumed.diagnostics)}`
  );
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

test("syncRun does not count a retried zero-usage attempt as an unpriced event", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-retried-zero-usage";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 2 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: { iteration: 0, model: "deepseek-v4-flash", agent: "deepseek" }
      },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        error: { message: "failed before model usage" },
        extra: { iteration: 0 }
      },
      { type: "NodeRetrying", nodeId: "node:project-discovery", attempt: 2, extra: { iteration: 0 } },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 2, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 2,
        extra: {
          iteration: 0,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 15,
          costUsd: 0.25,
          model: "deepseek-v4-flash",
          agent: "deepseek"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 2, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    deepseek: {
      models: {
        "deepseek-v4-flash": {
          cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 0 }
        }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "retried-zero-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "retried-zero-usage", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        total_tokens?: number;
        estimated_spend_usd?: number;
        usage_complete?: boolean;
        usage_incomplete_reasons?: Array<{ code?: string }>;
        pricing_complete?: boolean;
        pricing_incomplete_reasons?: unknown[];
        partial_pricing?: boolean;
        event_count?: number;
        priced_event_count?: number;
        unpriced_event_count?: number;
      };
      cumulative?: {
        estimated_spend_usd?: number;
        pricing_complete?: boolean;
        partial_pricing?: boolean;
        unpriced_event_count?: number;
      };
      checkpoint?: { ledger_event_count?: number };
    };
  };
  assert.equal(metadata.accounting?.current?.total_tokens, 15);
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, 0.25);
  assert.equal(metadata.accounting?.current?.usage_complete, false);
  assert.deepEqual(
    metadata.accounting?.current?.usage_incomplete_reasons?.map((reason) => reason.code),
    ["usage-missing"]
  );
  assert.equal(metadata.accounting?.current?.pricing_complete, true);
  assert.deepEqual(metadata.accounting?.current?.pricing_incomplete_reasons, []);
  assert.equal(metadata.accounting?.current?.partial_pricing, false);
  assert.equal(metadata.accounting?.current?.event_count, 1);
  assert.equal(metadata.accounting?.current?.priced_event_count, 1);
  assert.equal(metadata.accounting?.current?.unpriced_event_count, 0);
  assert.equal(metadata.accounting?.cumulative?.estimated_spend_usd, 0.25);
  assert.equal(metadata.accounting?.cumulative?.pricing_complete, true);
  assert.equal(metadata.accounting?.cumulative?.partial_pricing, false);
  assert.equal(metadata.accounting?.cumulative?.unpriced_event_count, 0);
  assert.equal(metadata.accounting?.checkpoint?.ledger_event_count, 2);

  const secondWorkflowRunId = "ultrafuzz-retried-zero-usage-relinked";
  env.SMITHERS_FAKE_FORKED_RUN_ID = secondWorkflowRunId;
  const forked = await forkRun({
    projectRoot: project,
    runId: "retried-zero-usage",
    forkFrame: 0,
    env
  });
  assert.equal(forked.ok, true, JSON.stringify(forked.diagnostics));
  assert.equal(forked.value?.workflow_run_id, secondWorkflowRunId);
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
  fs.writeFileSync(
    path.join(project, "fake-smithers-events.ndjson"),
    workflowEvents(secondWorkflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 4,
          outputTokens: 2,
          costUsd: 0.1,
          model: "deepseek-v4-flash",
          agent: "deepseek"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ]),
    "utf8"
  );

  const relinked = await syncRun({ projectRoot: project, runId: "retried-zero-usage", env });
  assert.equal(relinked.ok, true, JSON.stringify(relinked.diagnostics));
  const afterRelink = fs.readFileSync(metadataPath, "utf8");
  const replayed = await syncRun({ projectRoot: project, runId: "retried-zero-usage", env });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.equal(fs.readFileSync(metadataPath, "utf8"), afterRelink, "accounting replay must be byte-idempotent");

  const finalMetadata = JSON.parse(afterRelink) as {
    accounting?: {
      segments?: Array<{
        workflow_run_id?: string;
        pricing_complete?: boolean;
        event_count?: number;
        priced_event_count?: number;
        unpriced_event_count?: number;
      }>;
      cumulative?: {
        pricing_complete?: boolean;
        partial_pricing?: boolean;
        event_count?: number;
        priced_event_count?: number;
        unpriced_event_count?: number;
      };
      checkpoint?: { failed_zero_usage_source_event_ids?: string[] };
    };
  };
  assert.deepEqual(
    finalMetadata.accounting?.segments?.map((segment) => [
      segment.workflow_run_id,
      segment.pricing_complete,
      segment.event_count,
      segment.priced_event_count,
      segment.unpriced_event_count
    ]),
    [
      [workflowRunId, true, 1, 1, 0],
      [secondWorkflowRunId, true, 1, 1, 0]
    ]
  );
  assert.equal(finalMetadata.accounting?.cumulative?.pricing_complete, true);
  assert.equal(finalMetadata.accounting?.cumulative?.partial_pricing, false);
  assert.equal(finalMetadata.accounting?.cumulative?.event_count, 2);
  assert.equal(finalMetadata.accounting?.cumulative?.priced_event_count, 2);
  assert.equal(finalMetadata.accounting?.cumulative?.unpriced_event_count, 0);
  assert.equal(finalMetadata.accounting?.checkpoint?.failed_zero_usage_source_event_ids?.length, 1);
});

test("syncRun does not confuse restarted retry counters across checkpoint generations", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-restarted-zero-usage";
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
        sequence: 0,
        extra: { iteration: 0, checkpointGenerationId: "checkpoint-1" }
      },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 2,
        error: { message: "failed before model usage" },
        extra: { iteration: 0 }
      },
      {
        type: "NodeStarted",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 3,
        extra: { iteration: 0, checkpointGenerationId: "checkpoint-2" }
      },
      {
        type: "NodeFinished",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 5,
        extra: { iteration: 0 }
      },
      { type: "RunFinished", sequence: 6 }
    ]),
    tokenEvents: workflowEvents(workflowRunId, [
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "checkpoint-1",
          model: "deepseek-v4-flash",
          agent: "deepseek"
        }
      },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        sequence: 4,
        extra: {
          iteration: 0,
          checkpointGenerationId: "checkpoint-2",
          model: "deepseek-v4-flash",
          agent: "deepseek"
        }
      }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    deepseek: {
      models: {
        "deepseek-v4-flash": {
          cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 0 }
        }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "restarted-zero-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "restarted-zero-usage", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        checkpoint_generation_id?: string;
        pricing_complete?: boolean;
        partial_pricing?: boolean;
        event_count?: number;
        unpriced_event_count?: number;
      };
      segments?: Array<{
        checkpoint_generation_id?: string;
        pricing_complete?: boolean;
        event_count?: number;
        unpriced_event_count?: number;
      }>;
      checkpoint?: { ledger_event_count?: number };
    };
  };
  assert.deepEqual(
    metadata.accounting?.segments?.map((segment) => [
      segment.checkpoint_generation_id,
      segment.pricing_complete,
      segment.event_count,
      segment.unpriced_event_count
    ]),
    [
      ["checkpoint-1", true, 0, 0],
      ["checkpoint-2", false, 1, 1]
    ]
  );
  assert.equal(metadata.accounting?.current?.checkpoint_generation_id, "checkpoint-2");
  assert.equal(metadata.accounting?.current?.pricing_complete, false);
  assert.equal(metadata.accounting?.current?.partial_pricing, true);
  assert.equal(metadata.accounting?.current?.event_count, 1);
  assert.equal(metadata.accounting?.current?.unpriced_event_count, 1);
  assert.equal(metadata.accounting?.checkpoint?.ledger_event_count, 2);
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
  const generatedSegment = (generation: string, inputTokens: number, outputTokens: number, costUsd: number) =>
    workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
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
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ]);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect,
    events: generatedSegment("generation-1", 10, 5, 0.01)
  });
  const run = await startRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);

  const first = await syncRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));

  const generatedEventsPath = path.join(project, "fake-smithers-events.ndjson");
  fs.writeFileSync(generatedEventsPath, generatedSegment("generation-2", 20, 10, 0.02), "utf8");
  const second = await syncRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  const replayed = await syncRun({ projectRoot: project, runId: "generated-usage", env });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));

  fs.writeFileSync(
    generatedEventsPath,
    workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "generation-3",
          inputTokens: "malformed",
          model: "generated-model",
          agent: "generated-agent"
        }
      },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: "generation-3",
          model: "generated-model",
          agent: "generated-agent"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
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
        pricing_incomplete_reasons?: Array<{ code?: string }>;
        event_count?: number;
        unpriced_event_count?: number;
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
  assert.equal(metadata.accounting?.current?.event_count, 2);
  assert.equal(metadata.accounting?.current?.unpriced_event_count, 2);
  assert.deepEqual(
    metadata.accounting?.current?.pricing_incomplete_reasons?.map((reason) => reason.code),
    ["price-unavailable", "price-unavailable"]
  );
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
    events: usageEvents(firstWorkflowRunId, 10)
  });
  const run = await startRun({ projectRoot: project, runId: "colliding-generation", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const first = await syncRun({ projectRoot: project, runId: "colliding-generation", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));

  const metadataPath = path.join(run.value!.run_root, "run.json");
  env.SMITHERS_FAKE_FORKED_RUN_ID = secondWorkflowRunId;
  const forked = await forkRun({
    projectRoot: project,
    runId: "colliding-generation",
    forkFrame: 0,
    env
  });
  assert.equal(forked.ok, true, JSON.stringify(forked.diagnostics));
  assert.equal(forked.value?.workflow_run_id, secondWorkflowRunId);
  const linkJournal = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "workflow-run-link-journal.json"), "utf8")
  ) as {
    entries?: Array<{
      link_id?: string;
      action?: string;
      workflow_run_id?: string;
      source_workflow_run_id?: string;
      source_workflow_link_id?: string;
      lifecycle_result_event_id?: string;
      phase?: string;
    }>;
  };
  assert.equal(linkJournal.entries?.length, 2);
  assert.deepEqual(
    linkJournal.entries?.map((entry) => [entry.action, entry.workflow_run_id, entry.phase]),
    [
      ["start", firstWorkflowRunId, "committed"],
      ["fork", secondWorkflowRunId, "committed"]
    ]
  );
  assert.equal(linkJournal.entries?.[1]?.source_workflow_run_id, firstWorkflowRunId);
  assert.equal(linkJournal.entries?.[1]?.source_workflow_link_id, linkJournal.entries?.[0]?.link_id);
  assert.match(linkJournal.entries?.[1]?.lifecycle_result_event_id ?? "", /^evt-/u);
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

  const second = await syncRun({ projectRoot: project, runId: "colliding-generation", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  const finalMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    workflow?: { run_id?: string; workflow_link_id?: string };
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
  assert.equal(finalMetadata.workflow?.run_id, secondWorkflowRunId);
  assert.equal(finalMetadata.workflow?.workflow_link_id, linkJournal.entries?.[1]?.link_id);
  const finalState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    provenance?: { workflow?: { runId?: string; linkId?: string } };
  };
  assert.equal(finalState.provenance?.workflow?.runId, secondWorkflowRunId);
  assert.equal(finalState.provenance?.workflow?.linkId, linkJournal.entries?.[1]?.link_id);
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
  const generatedSegment = (generation: string) =>
    workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 1,
        extra: {
          iteration: 0,
          checkpointGenerationId: generation,
          inputTokens: 1,
          outputTokens: 0,
          costUsd: 0.0000004
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ]);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: generatedSegment("generation-1")
  });
  const run = await startRun({ projectRoot: project, runId: "precise-cost-usage", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const first = await syncRun({ projectRoot: project, runId: "precise-cost-usage", env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  fs.writeFileSync(path.join(project, "fake-smithers-events.ndjson"), generatedSegment("generation-2"), "utf8");

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
    event(2, 200, "TokenUsageReported", {
      nodeId: "node:project-discovery",
      iteration: 0,
      attempt: 1,
      checkpointGenerationId: "generation-2",
      inputTokens: 20,
      costUsd: 0.02
    }),
    event(3, 400, "NodeFinished", { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }),
    event(4, 500, "RunFinished")
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
    workflowEvents(workflowRunId, [...firstSegment, tokenEvent(20, 10, 0.02)]),
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
          // DeepSeek output already includes thinking tokens; emitting another
          // reasoning component would double-count the provider's completion.
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

test("syncRun fails a successful workflow node that is missing required artifacts", async () => {
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

  const graceStartedAt = Date.parse("2026-07-03T00:01:00.000Z");
  const pending = await syncRun({ projectRoot: project, runId: "sync-missing", env }, { now: () => graceStartedAt });

  assert.equal(pending.ok, true);
  assert.equal(pending.value?.status, "running");
  assert.ok(pending.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"));
  const attemptLedgerPath = path.join(run.value!.run_root, "attempts.jsonl");
  assert.equal(
    fs.existsSync(attemptLedgerPath) ? fs.readFileSync(attemptLedgerPath, "utf8").trim() : "",
    "",
    "a successful executor attempt must stay pending until its output manifest is durable"
  );
  assert.equal(
    fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8").match(/node-artifacts-missing/gu),
    null
  );

  const sync = await syncRun(
    { projectRoot: project, runId: "sync-missing", env },
    { now: () => graceStartedAt + ARTIFACT_RECONCILIATION_GRACE_MS }
  );

  assert.equal(sync.ok, true);
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_MISSING"));
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
  assert.match(state.nodes?.["project-discovery"]?.last_error ?? "", /setup\/project-discovery\.md/);
  assert.deepEqual(state.nodes?.["project-discovery"]?.provenance?.failure, {
    category: "artifact-contract",
    causal_task_id: "verify:project-discovery",
    causal_failure_category: "artifact-contract",
    dependent_task_ids: []
  });
  assert.equal(state.nodes?.["project-discovery"]?.provenance?.terminal_disposition, undefined);
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    true
  );

  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const repaired = await syncRun(
    { projectRoot: project, runId: "sync-missing", env },
    { now: () => graceStartedAt + ARTIFACT_RECONCILIATION_GRACE_MS + 1 }
  );
  assert.equal(repaired.ok, true, JSON.stringify(repaired.diagnostics));
  assert.equal(repaired.value?.status, "succeeded");
  const repairedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string; last_error?: string }>;
  };
  assert.equal(repairedState.nodes?.["project-discovery"]?.status, "succeeded");
  assert.equal(repairedState.nodes?.["project-discovery"]?.last_error, undefined);
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
  const attemptLedgerPath = path.join(run.value!.run_root, "attempts.jsonl");
  const now = Date.parse("2026-07-03T00:02:00.000Z");

  const pending = await syncRun({ projectRoot: project, runId: "sync-late-mirror", env }, { now: () => now });
  assert.equal(pending.ok, true, JSON.stringify(pending.diagnostics));
  assert.equal(pending.value?.status, "running");
  assert.ok(pending.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_ARTIFACT_GRACE_PENDING"));
  assert.equal(
    fs.existsSync(attemptLedgerPath) ? fs.readFileSync(attemptLedgerPath, "utf8").trim() : "",
    "",
    "a successful executor attempt must stay pending until its output manifest is durable"
  );

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
  const attemptLedger = fs
    .readFileSync(attemptLedgerPath, "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          outcome?: string;
          failure_category?: string;
          manifests?: { output_sha256?: unknown };
        }
    );
  assert.equal(attemptLedger.length, 1);
  assert.equal(attemptLedger[0]?.outcome, "succeeded");
  assert.equal(attemptLedger[0]?.failure_category, undefined);
  assert.match(String(attemptLedger[0]?.manifests?.output_sha256), /^[a-f0-9]{64}$/u);
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
  assert.equal(clockReads, 2);
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
    const deadline = startedAt + 100;
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
        if (mode === "deadline" && sourceReads === 2) {
          currentTime = deadline;
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

    assert.equal(interrupted.ok, false, mode);
    assert.ok(
      interrupted.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === (mode === "deadline" ? "WORKFLOW_SYNC_DEADLINE_EXCEEDED" : "WORKFLOW_SYNC_CANCELLED")
      ),
      mode
    );
    assert.ok(sourceReads >= 1, mode);
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
  fs.writeFileSync(
    smithers,
    `#!${process.execPath}
if (process.argv[2] === "inspect") {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write('{"ok":true}\\n');
}
`,
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  const env = {
    SMITHERS_BIN: smithers,
    ULTRAFUZZ_PRICING_CATALOG_URL: "off"
  };
  const run = await startRun({ projectRoot: project, runId: "sync-blocked-child", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const statePath = path.join(run.value!.run_root, "state.json");
  const before = fs.readFileSync(statePath, "utf8");

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 50);
  const abortStartedAt = Date.now();
  const cancelled = await syncRun(
    { projectRoot: project, runId: "sync-blocked-child", env },
    { signal: controller.signal }
  );
  clearTimeout(abortTimer);
  assert.equal(cancelled.ok, false);
  assert.ok(cancelled.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CANCELLED"));
  assert.ok(Date.now() - abortStartedAt < 2_000);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);

  const deadlineStartedAt = Date.now();
  const expired = await syncRun(
    { projectRoot: project, runId: "sync-blocked-child", env },
    { deadlineMs: deadlineStartedAt + 100 }
  );
  assert.equal(expired.ok, false);
  assert.ok(expired.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED"));
  assert.ok(Date.now() - deadlineStartedAt < 2_000);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
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
  assert.deepEqual(
    failedLedger.map((entry) => entry.failure_message),
    ["workflow task timed out", "agent failed again"]
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
  assert.equal(ledger[0]?.failure_message, "generated executor failure");
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
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
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
      { type: "RunAutoResumed", extra: { controllerInvocationId: "controller-resume" } },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } }
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
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.controller_invocation_id, "controller-start");
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
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodePending", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeWaitingApproval", nodeId: "node:project-discovery", attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "wait-event-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "wait-event-run", env });

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

test("resume, replay, and fork delegate linked runs to Smithers lifecycle verbs", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const credentialLog = path.join(project, "lifecycle-credential-env.log");
  const hostileCredential = "must-not-cross-sealed-lifecycle-boundary";
  env.AWS_SECRET_ACCESS_KEY = hostileCredential;
  env.SMITHERS_FAKE_ENV_LOG = credentialLog;
  const run = await startRun({ projectRoot: project, runId: "lifecycle-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  fs.writeFileSync(credentialLog, "", "utf8");
  const sealedPlan = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "plan.json"), "utf8")) as {
    rendered_prompts: Array<{
      rendered_prompt_path: string;
      rendered_prompt_snapshot_path: string;
    }>;
  };
  const missingPrompt = sealedPlan.rendered_prompts[0]!;
  const expectedPrompt = fs.readFileSync(missingPrompt.rendered_prompt_path, "utf8");
  fs.rmSync(missingPrompt.rendered_prompt_path);
  fs.rmSync(path.join(run.value!.run_root, missingPrompt.rendered_prompt_snapshot_path));
  const mutableConfigPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    mutableConfigPath,
    fs
      .readFileSync(mutableConfigPath, "utf8")
      .replace('api_key_env = "OPENAI_API_KEY"', 'api_key_env = "AWS_SECRET_ACCESS_KEY"'),
    "utf8"
  );
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
  assert.equal(fs.readFileSync(missingPrompt.rendered_prompt_path, "utf8"), expectedPrompt);
  assert.doesNotMatch(fs.readFileSync(credentialLog, "utf8"), new RegExp(hostileCredential, "u"));
  const resumedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as RunState;
  assert.equal(resumedState.concurrency.requested_concurrency, 8);
  assert.equal(resumedState.controller_lease.duration_ms, 30_000);
  assert.equal(resumedState.status, "running");
  assert.equal(resumedState.finished_at, undefined);
  assert.notEqual(resumedState.workflow_deadline_at, "2000-01-01T00:00:00.000Z");
  assert.ok(Date.parse(resumedState.workflow_deadline_at ?? "") > resumeSubmittedAfterMs);

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

  const replayed = await replayRun({ projectRoot: project, runId: run.value!.run_id, env });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.equal(replayed.value?.workflow_run_id, "ultrafuzz-lifecycle-run-replayed");
  assert.equal(replayed.value?.submitted, true);
  assert.doesNotMatch(fs.readFileSync(credentialLog, "utf8"), new RegExp(hostileCredential, "u"));

  const missingFrame = await forkRun({ projectRoot: project, runId: run.value!.run_id, env });
  assert.equal(missingFrame.ok, false);
  assert.equal(missingFrame.diagnostics[0]?.code, "WORKFLOW_FORK_FRAME_REQUIRED");

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
  assert.doesNotMatch(fs.readFileSync(credentialLog, "utf8"), new RegExp(hostileCredential, "u"));
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    workflow?: { run_id?: string; workflow_link_id?: string };
    workflow_ids?: string[];
  };
  assert.equal(metadata.workflow?.run_id, "ultrafuzz-lifecycle-run-forked");
  assert.deepEqual(metadata.workflow_ids, ["ultrafuzz-lifecycle-run-forked"]);
  const linkJournal = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "workflow-run-link-journal.json"), "utf8")
  ) as {
    entries?: Array<{
      link_id?: string;
      action?: string;
      workflow_run_id?: string;
      source_workflow_run_id?: string;
      source_workflow_link_id?: string;
      controller_invocation_id?: string;
      lifecycle_result_event_id?: string;
      phase?: string;
    }>;
  };
  assert.deepEqual(
    linkJournal.entries?.map((entry) => [entry.action, entry.workflow_run_id, entry.phase]),
    [
      ["start", "ultrafuzz-lifecycle-run", "committed"],
      ["replay", "ultrafuzz-lifecycle-run-replayed", "committed"],
      ["fork", "ultrafuzz-lifecycle-run-forked", "committed"]
    ]
  );
  const linkEntries = linkJournal.entries ?? [];
  for (let index = 1; index < linkEntries.length; index += 1) {
    const previous = linkEntries[index - 1]!;
    const current = linkEntries[index]!;
    assert.equal(current?.source_workflow_run_id, previous?.workflow_run_id);
    assert.equal(current?.source_workflow_link_id, previous?.link_id);
    assert.match(current?.controller_invocation_id ?? "", /^evt-/u);
    assert.match(current?.lifecycle_result_event_id ?? "", /^evt-/u);
  }
  assert.equal(metadata.workflow?.workflow_link_id, linkJournal.entries?.at(-1)?.link_id);
  const freshEvidence = await readLinkedWorkflowEvidence(project, run.value!.run_id);
  assert.equal(freshEvidence.ok, true, "diagnostics" in freshEvidence ? JSON.stringify(freshEvidence.diagnostics) : "");
  if (freshEvidence.ok) {
    assert.equal(freshEvidence.smithersRunId, "ultrafuzz-lifecycle-run-forked");
    assert.equal(freshEvidence.workflowLinkId, linkJournal.entries?.at(-1)?.link_id);
    const sealedTasks = JSON.parse(freshEvidence.verifiedControl.contents.tasks.toString("utf8")) as {
      smithers_run_id?: string;
    };
    assert.equal(sealedTasks.smithers_run_id, "ultrafuzz-lifecycle-run");
  }
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run --run-id ultrafuzz-lifecycle-run --detach --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/
  );
  assert.match(
    commands,
    /timetravel .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run --node-id node:project-discovery --no-vcs --force --format json/
  );
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run --run-id ultrafuzz-lifecycle-run --force --detach --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/
  );
  assert.match(commands, /replay .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run --format json/);
  assert.match(
    commands,
    /fork .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run-replayed --frame 44 --reset-node node:project-discovery --label after-edit --format json/
  );
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run-forked --run-id ultrafuzz-lifecycle-run-forked --force --detach --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/
  );
  const runLogsDir = path.join(run.value!.run_root, "smithers", "logs");
  for (const relaunch of commands.split("\n").filter((line) => line.startsWith("up ") && line.includes("--resume "))) {
    assert.ok(
      relaunch.includes(`--log-dir ${runLogsDir} `),
      `a relaunched workflow must keep streaming into the run's own log directory: ${relaunch}`
    );
  }
});

test("lifecycle relaunch rejects a required backend that disappeared before new attempts", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const topologyPath = path.join(project, ".ultrafuzz", "topology.yml");
  fs.writeFileSync(
    topologyPath,
    fs
      .readFileSync(topologyPath, "utf8")
      .replace(
        "    prompt: setup/project-discovery.md\n",
        "    prompt: setup/project-discovery.md\n    required_commands: [recon-required-test]\n"
      ),
    "utf8"
  );
  const env = fakeSmithersEnv(project);
  const recon = path.join(project, "fake-bin", "recon-required-test");
  fs.writeFileSync(recon, "#!/bin/sh\necho recon test\n", "utf8");
  fs.chmodSync(recon, 0o755);
  const run = await startRun({ projectRoot: project, runId: "lifecycle-required-command", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.rmSync(recon);
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  const eventsPath = path.join(run.value!.run_root, "events.jsonl");
  const eventsBefore = fs.readFileSync(eventsPath, "utf8");

  const resumed = await resumeRun({ projectRoot: project, runId: run.value!.run_id, env });

  assert.equal(resumed.ok, false);
  assert.equal(resumed.diagnostics[0]?.code, "RUN_REQUIRED_COMMAND_MISSING");
  assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), "");
  assert.equal(fs.readFileSync(eventsPath, "utf8"), eventsBefore);
});

test("legacy workflow evidence gaps fail closed without reconstructing trust", async () => {
  const cases = [
    {
      runId: "legacy-missing-control-seal",
      relativePath: path.join("smithers", "control-integrity.json"),
      code: "WORKFLOW_CONTROL_SEAL_MISSING",
      message: /control seal.*cannot be safely upgraded in place.*new run ID/u
    },
    {
      runId: "legacy-missing-link-journal",
      relativePath: path.join("smithers", "workflow-run-link-journal.json"),
      code: "WORKFLOW_RUN_LINK_JOURNAL_MISSING",
      message: /workflow-link journal.*cannot be safely upgraded in place.*new run ID/u
    }
  ] as const;

  for (const entry of cases) {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    writeSmallTopology(project);
    const env = fakeSmithersEnv(project);
    const run = await startRun({ projectRoot: project, runId: entry.runId, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const missingPath = path.join(run.value!.run_root, entry.relativePath);
    fs.unlinkSync(missingPath);
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

    const evidence = await readLinkedWorkflowEvidence(project, entry.runId);

    assert.equal(evidence.ok, false);
    if (!evidence.ok) {
      assert.equal(evidence.diagnostics[0]?.code, entry.code);
      assert.equal(evidence.diagnostics[0]?.path, missingPath);
      assert.match(evidence.diagnostics[0]?.message ?? "", entry.message);
    }
    const resumed = await resumeRun({ projectRoot: project, runId: entry.runId, env });
    assert.equal(resumed.ok, false);
    assert.equal(resumed.diagnostics[0]?.code, entry.code);
    assert.equal(fs.existsSync(missingPath), false, "legacy evidence must never be synthesized");
    assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), "");
  }
});

test("a symlinked control seal remains invalid evidence rather than being labeled legacy", async () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  writeSmallTopology(project);
  const runId = "symlinked-control-seal";
  const run = await startRun({ projectRoot: project, runId, env: fakeSmithersEnv(project) });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const sealPath = path.join(run.value!.run_root, "smithers", "control-integrity.json");
  const retainedPath = `${sealPath}.retained`;
  fs.renameSync(sealPath, retainedPath);
  fs.symlinkSync(retainedPath, sealPath);

  const evidence = await readLinkedWorkflowEvidence(project, runId);

  assert.equal(evidence.ok, false);
  if (!evidence.ok) {
    assert.equal(evidence.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
    assert.notEqual(evidence.diagnostics[0]?.code, "WORKFLOW_CONTROL_SEAL_MISSING");
  }
});

test("lifecycle commands reject a coherent metadata and state retarget before invoking Smithers", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "retargeted-workflow-link", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const forgedWorkflowRunId = "ultrafuzz-retargeted-workflow-link-forged";
  const metadataPath = path.join(run.value!.run_root, "run.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    workflow_ids?: string[];
    workflow?: { run_id?: string };
  };
  assert.ok(metadata.workflow);
  metadata.workflow.run_id = forgedWorkflowRunId;
  metadata.workflow_ids = [forgedWorkflowRunId];
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  const statePath = path.join(run.value!.run_root, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    provenance?: { workflow?: { runId?: string; inspection?: { runId?: string } } };
  };
  const stateWorkflow = state.provenance?.workflow;
  assert.ok(stateWorkflow);
  stateWorkflow.runId = forgedWorkflowRunId;
  stateWorkflow.inspection = { runId: forgedWorkflowRunId };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({ projectRoot: project, runId: run.value!.run_id, env });

  assert.equal(resumed.ok, false);
  assert.equal(resumed.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
  assert.match(resumed.diagnostics[0]?.message ?? "", /cross-bound to its control and link journals/u);
  assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), "");
});

test("a pending workflow link cannot forge a target from an unrelated lifecycle result", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "forged-workflow-link-target", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const resumed = await resumeRun({ projectRoot: project, runId: run.value!.run_id, env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));

  const journalPath = path.join(run.value!.run_root, "smithers", "workflow-run-link-journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<Record<string, unknown>>;
  };
  const source = journal.entries.at(-1);
  assert.ok(source);
  const events = fs
    .readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event_id: string; event_type: string; timestamp: string });
  const invocation = events.filter((event) => event.event_type === "workflow-lifecycle-invoking").at(-1);
  const lifecycleResult = events.filter((event) => event.event_type === "workflow-lifecycle-result").at(-1);
  assert.ok(invocation);
  assert.ok(lifecycleResult);
  const preparedAt = new Date().toISOString();
  journal.entries.push({
    link_id: crypto.randomUUID(),
    action: "resume",
    workflow_run_id: "ultrafuzz-forged-workflow-link-target-attacker",
    control_generation: source.control_generation,
    phase: "prepared",
    prepared_at: preparedAt,
    updated_at: preparedAt,
    source_workflow_run_id: source.workflow_run_id,
    source_workflow_link_id: source.link_id,
    controller_invocation_id: invocation.event_id,
    controller_invoked_at: invocation.timestamp,
    lifecycle_result_event_id: lifecycleResult.event_id,
    lifecycle_result_at: lifecycleResult.timestamp
  });
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const forged = await resumeRun({ projectRoot: project, runId: run.value!.run_id, env });

  assert.equal(forged.ok, false);
  assert.equal(forged.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
  assert.match(forged.diagnostics[0]?.message ?? "", /result does not authorize its journal target/u);
  assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), "");
});

test("a pristine initial-link projection is reconstructed only from sealed control evidence", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "initial-workflow-link-reconcile", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const journalPath = path.join(run.value!.run_root, "smithers", "workflow-run-link-journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<Record<string, unknown>>;
  };
  const initialLink = journal.entries[0];
  assert.ok(initialLink);
  initialLink.phase = "prepared";
  initialLink.updated_at = initialLink.prepared_at;
  delete initialLink.link_event_id;
  delete initialLink.link_event_at;
  delete initialLink.committed_at;
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

  const eventsPath = path.join(run.value!.run_root, "events.jsonl");
  const retainedEvents = fs
    .readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => (JSON.parse(line) as { event_type?: string }).event_type !== "workflow-link-recorded");
  fs.writeFileSync(eventsPath, `${retainedEvents.join("\n")}\n`, "utf8");
  const metadataPath = path.join(run.value!.run_root, "run.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  metadata.workflow_ids = [];
  delete metadata.workflow;
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  const statePath = path.join(run.value!.run_root, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    provenance?: Record<string, unknown>;
  };
  if (state.provenance !== undefined) delete state.provenance.workflow;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const evidence = await readLinkedWorkflowEvidence(project, run.value!.run_id);

  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (evidence.ok) assert.equal(evidence.workflowLinkId, initialLink.link_id);
  const reconciledJournal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries?: Array<{ phase?: string; link_event_id?: string }>;
  };
  assert.equal(reconciledJournal.entries?.[0]?.phase, "committed");
  assert.match(reconciledJournal.entries?.[0]?.link_event_id ?? "", /^evt-/u);
  const reconciledMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    workflow?: { run_id?: string; workflow_link_id?: string };
  };
  assert.equal(reconciledMetadata.workflow?.run_id, "ultrafuzz-initial-workflow-link-reconcile");
  assert.equal(reconciledMetadata.workflow?.workflow_link_id, initialLink.link_id);
});

test("a pending lifecycle link reconciles split source and target projections from its exact receipt", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const sourceWorkflowRunId = "ultrafuzz-partial-link-reconcile";
  const targetWorkflowRunId = "ultrafuzz-partial-link-reconcile-fork";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: sourceWorkflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "partial-link-reconcile", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const statePath = path.join(run.value!.run_root, "state.json");
  const sourceState = fs.readFileSync(statePath, "utf8");
  env.SMITHERS_FAKE_FORKED_RUN_ID = targetWorkflowRunId;
  const forked = await forkRun({ projectRoot: project, runId: run.value!.run_id, forkFrame: 0, env });
  assert.equal(forked.ok, true, JSON.stringify(forked.diagnostics));

  const journalPath = path.join(run.value!.run_root, "smithers", "workflow-run-link-journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<Record<string, unknown>>;
  };
  const pending = journal.entries.at(-1);
  assert.ok(pending);
  pending.phase = "prepared";
  pending.updated_at = pending.prepared_at;
  delete pending.link_event_id;
  delete pending.link_event_at;
  delete pending.committed_at;
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  fs.writeFileSync(statePath, sourceState, "utf8");
  const eventsPath = path.join(run.value!.run_root, "events.jsonl");
  const retainedEvents = fs
    .readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => {
      const event = JSON.parse(line) as { event_type?: string; payload?: { workflow_link_id?: unknown } };
      return event.event_type !== "workflow-link-recorded" || event.payload?.workflow_link_id !== pending.link_id;
    });
  fs.writeFileSync(eventsPath, `${retainedEvents.join("\n")}\n`, "utf8");

  const evidence = await readLinkedWorkflowEvidence(project, run.value!.run_id);

  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (evidence.ok) {
    assert.equal(evidence.smithersRunId, targetWorkflowRunId);
    assert.equal(evidence.workflowLinkId, pending.link_id);
  }
  const reconciledState = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    provenance?: { workflow?: { runId?: string; linkId?: string } };
  };
  assert.equal(reconciledState.provenance?.workflow?.runId, targetWorkflowRunId);
  assert.equal(reconciledState.provenance?.workflow?.linkId, pending.link_id);
  const reconciledJournal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries?: Array<{ phase?: string }>;
  };
  assert.equal(reconciledJournal.entries?.at(-1)?.phase, "committed");
});

test("resume keeps an already-running linked workflow attached without launching a duplicate", async () => {
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

  const resumed = await resumeRun({ projectRoot: project, runId: "active-lifecycle-run", maxConcurrency: 8, env });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.workflow_run_id, "ultrafuzz-active-lifecycle-run");
  assert.equal(resumed.value?.submitted, false);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /inspect ultrafuzz-active-lifecycle-run --format json/u);
  assert.doesNotMatch(commands, /^up /mu);

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
    /up .*ultrafuzz-active-lifecycle-run\.tsx --resume ultrafuzz-active-lifecycle-run --run-id ultrafuzz-active-lifecycle-run --force --detach --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/u
  );
});

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
    /up .*ultrafuzz-terminal-retry-run\.tsx --resume ultrafuzz-terminal-retry-run --run-id ultrafuzz-terminal-retry-run --force --detach --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/u
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
    /up .*ultrafuzz-terminal-row-retry-run\.tsx --resume ultrafuzz-terminal-row-retry-run --run-id ultrafuzz-terminal-row-retry-run --force --detach --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/u
  );
});

test("resume retries one failed workflow task before continuing a stale unfinished run", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-stale-retry-run",
      status: "running",
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
    /up .*ultrafuzz-stale-retry-run\.tsx --resume ultrafuzz-stale-retry-run --run-id ultrafuzz-stale-retry-run --force --detach --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/u
  );
});

test("resume continues a run-level render failure in place without a no-op rewind", async () => {
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
  // A jump to the latest frame returns early upstream, so reading the timeline and rewinding to it
  // spends two subprocesses per recovery generation and mutates nothing.
  assert.doesNotMatch(commands, /timeline|rewind|retry-task/u);
  assert.match(
    commands,
    /up .*ultrafuzz-render-recovery-run\.tsx --resume ultrafuzz-render-recovery-run --run-id ultrafuzz-render-recovery-run --force --detach --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/u
  );
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

test("resume adopts an orphaned replacement lineage that already exists", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = `orphan-${"x".repeat(56)}`;
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
  // An earlier recovery generation already created the deterministic replacement run and died
  // before the new lineage was persisted, so a fresh submission now reports RUN_EXISTS.
  env.SMITHERS_FAKE_RUN_EXISTS = "1";

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
  const replacementRunId = resumed.value?.workflow_run_id ?? "";
  assert.match(replacementRunId, /^ufz-recovery-[a-f0-9]{32}$/u);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, new RegExp(`up .* --detach --run-id ${replacementRunId}`, "u"));
  assert.match(
    commands,
    new RegExp(`up .* --detach --resume ${replacementRunId} --run-id ${replacementRunId} --force`, "u")
  );
  const recovery = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "recovery-submission.json"), "utf8")
  ) as { recovery?: string; smithers_run_id?: string };
  assert.equal(recovery.recovery, "incompatible-workflow-run-id-adopted");
  assert.equal(recovery.smithers_run_id, replacementRunId);
  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    workflow?: { run_id?: string };
  };
  assert.equal(metadata.workflow?.run_id, replacementRunId);
});

test("resume classifies a terminal run reported only at the top level of the inspect payload", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = `toplevel-${"x".repeat(56)}`;
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    // Neither a `runState` nor a `run` wrapper: some run-state and task-output snapshot variants
    // report the state at the top level of `data`.
    inspect: {
      ok: true,
      data: {
        id: workflowRunId,
        state: "failed",
        error: { code: "WORKFLOW_RENDER_FAILED", cause: { code: "ENOENT" } },
        steps: [{ id: "node:project-discovery", state: "pending", attempt: 0 }]
      }
    }
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
  assert.match(resumed.value?.workflow_run_id ?? "", /^ufz-recovery-[a-f0-9]{32}$/u);
});

test("unverified dependency detection reads a dependent prepare failure off the run row", async () => {
  const { smithersSnapshotUnverifiedDependencies } = await import("../src/smithers.js");
  const runError = {
    name: "SmithersError",
    code: "SESSION_ERROR",
    message: "Task failed: prepare:property-specification-fanin",
    cause: {
      message:
        "artifact-contract failure: artifact dependency has not passed verification " +
        "property-specification-crytic for property-specification-fanin"
    }
  };
  const snapshot = {
    command: ["inspect", "ultrafuzz-r43", "--format", "json"],
    ok: true,
    stdout: "",
    stderr: "",
    json: { ok: true, data: { run: { id: "ultrafuzz-r43", status: "failed", error: runError } } }
  };

  assert.deepEqual(smithersSnapshotUnverifiedDependencies(snapshot), ["property-specification-crytic"]);
  assert.deepEqual(
    smithersSnapshotUnverifiedDependencies({ ...snapshot, json: undefined, stderr: "unrelated failure" }),
    []
  );
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
    /up .*ultrafuzz-reset-lifecycle-run\.tsx --resume ultrafuzz-reset-lifecycle-run --run-id ultrafuzz-reset-lifecycle-run --force --detach( --max-concurrency \d+)? --log-dir \S+\/smithers\/logs --format json/u
  );
});

test("resume re-submits persisted workflow evidence when the workflow run was never created", async () => {
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
  const pinnedRunner = writeFakeInstalledSmithers(project);
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
      "  printf '%s\\n' '{\"code\":\"INSPECT_FAILED\",\"message\":\"No Smithers run history found at /workspace/target/smithers.db. Run '\\''smithers up <workflow>'\\'' to start a run first.\"}'",
      "  exit 1",
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
  fs.copyFileSync(smithers, pinnedRunner.target);
  fs.chmodSync(pinnedRunner.target, 0o755);
  const env = {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: smithers,
    SMITHERS_FAKE_LOG: logPath,
    SMITHERS_FAKE_CLOUD_ENV_LOG: cloudEnvironmentLog,
    UFZ_PROVIDER_ONE: "provider-one",
    UFZ_PROVIDER_TWO: "provider-two",
    SMITHERS_FAKE_MARKER: markerPath
  };

  const initial = await startRun({ projectRoot: project, runId: "missing-workflow-run", env });
  assert.equal(initial.ok, false);
  fs.writeFileSync(configPath, localConfig, "utf8");
  fs.writeFileSync(cloudEnvironmentLog, "", "utf8");

  const resumed = await resumeRun({
    projectRoot: project,
    runId: "missing-workflow-run",
    maxConcurrency: 8,
    env
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.workflow_run_id, "ultrafuzz-missing-workflow-run");

  const commands = fs.readFileSync(logPath, "utf8").split("\n");
  const upCommands = commands.filter((line) => line.startsWith("up "));
  assert.equal(upCommands.length, 2);
  assert.match(commands.find((line) => line.startsWith("inspect ")) ?? "", /--format json/u);
  assert.doesNotMatch(upCommands[1] ?? "", /--resume/u);
  assert.match(upCommands[1] ?? "", /--max-concurrency 8 --root /u);
  assert.match(upCommands[1] ?? "", /--log-dir .* --input /u);
  assert.equal(fs.readFileSync(cloudEnvironmentLog, "utf8"), "provider-one|provider-two\n");

  const runRoot = path.join(project, ".ultrafuzz", "runs", "missing-workflow-run");
  const recovery = JSON.parse(fs.readFileSync(path.join(runRoot, "smithers", "recovery-submission.json"), "utf8")) as {
    recovery?: string;
    command?: string[];
  };
  assert.equal(recovery.recovery, "missing-workflow-run");
  assert.equal(recovery.command?.includes("<redacted>"), true);
  const state = JSON.parse(fs.readFileSync(path.join(runRoot, "state.json"), "utf8")) as { status?: string };
  assert.equal(state.status, "running");
});

test(
  "compiled Smithers workflow passes a real non-executing graph smoke",
  { skip: realSmithersGraphUnavailable() },
  async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    fs.symlinkSync(
      path.join(workspaceRoot(), ".smithers", "node_modules"),
      path.join(project, ".smithers", "node_modules"),
      "dir"
    );

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

    const graphProcess = spawnSync(
      "smithers",
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
    const graph = JSON.parse(graphJson) as { tasks?: Array<{ nodeId?: string }> };
    assert.equal(graph.tasks?.[0]?.nodeId, "prepare:project-discovery");
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
  try {
    execFileSync("smithers", ["graph", "--help"], { stdio: "ignore" });
  } catch {
    return "smithers CLI is not installed";
  }
  if (!fs.existsSync(path.join(workspaceRoot(), ".smithers", "node_modules", "smithers-orchestrator"))) {
    return ".smithers Smithers dependencies are not installed";
  }
  return false;
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
