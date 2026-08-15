import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  execFileSync,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns
} from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

import { test } from "./runtime-test-shard.js";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  artifactSchemaBundleDigest,
  artifactSchemaRegistry,
  ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
  createEventRecord,
  layoutForRunRoot,
  replayEvents,
  VALIDATOR_BUILD_IDENTITY,
  type RunState,
  type SMITHERS_NODE_STATES,
  type SMITHERS_RUN_STATES,
  type SMITHERS_RUN_STATUSES
} from "@ultrafuzz/artifacts";
import { parseResolvedConfigJsonBytes, serializeResolvedConfigJsonBytes } from "@ultrafuzz/config";
import {
  CACHE_MANIFEST_FILE,
  REFERENCE_CACHE_SCHEMA_VERSION,
  RUN_REFERENCE_MANIFEST_FILE
} from "@ultrafuzz/references";

import {
  assertSmithersPackageManifest,
  assertSmithersResolutionCutoff,
  KIMI_CODE_VERSION,
  renderSmithersPackageJson,
  REQUIRED_SMITHERS_OVERRIDES,
  SMITHERS_DEPENDENCY_RESOLUTION_CUTOFF,
  SMITHERS_EFFECT_VERSION,
  SMITHERS_BIN_PATH,
  SMITHERS_VERSION,
  smithersDependencyInstallArgs
} from "../src/smithers-package.js";
import { isTransientNpmRegistryFailure } from "../src/npm-install-retry.js";

import {
  forkRun as runtimeForkRun,
  getRunHealth,
  getRunStatus,
  initProject,
  listRuns,
  planRun,
  pauseRun,
  readLinkedWorkflowEvidence,
  replayRun as runtimeReplayRun,
  resumeRun as runtimeResumeRun,
  startRun as runtimeStartRun,
  syncRun,
  toPlannedGraph,
  validateProject
} from "../src/index.js";
import { inspectSmithersInstallation, runSmithersInspectionCommand } from "../src/smithers.js";
import { acquireWorkflowExecutionSnapshotAnchor } from "../src/workflow-execution-snapshot-capability.js";
import { materializeWorkflowExecutionSnapshot } from "../src/workflow-integrity.js";
import { linkedWorkflowExecutionEnvironment } from "../src/start-run.js";

const runningUnderBun = typeof process.versions.bun === "string";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-"));
}

function validatorPreflightResponse(): Record<string, unknown> {
  const findings = artifactSchemaRegistry().find((entry) => entry.filename === "findings.schema.json");
  assert.ok(findings);
  return {
    schema_version: "ultrafuzz.cli.result.v2",
    command: "json validate",
    ok: true,
    diagnostics: [],
    data: {
      status: "valid",
      diagnostics: [],
      schema: {
        id: findings.id,
        sha256: findings.sha256,
        bundle_sha256: artifactSchemaBundleDigest(),
        validator_build: VALIDATOR_BUILD_IDENTITY,
        registered: true
      },
      artifact_sha256: ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
      truncated: false
    }
  };
}

function fakeUltrafuzzCliEntrypoint(project: string): string {
  const entrypoint = path.join(project, "fake-ultrafuzz-cli.mjs");
  if (fs.existsSync(entrypoint)) return entrypoint;
  fs.writeFileSync(
    entrypoint,
    `process.stdout.write(${JSON.stringify(JSON.stringify(validatorPreflightResponse()))});\n`,
    "utf8"
  );
  fs.chmodSync(entrypoint, 0o500);
  return entrypoint;
}

function withFakeCliEntrypoint<T extends { projectRoot: string; ultrafuzzCliEntrypoint?: string }>(input: T): T {
  return {
    ...input,
    ultrafuzzCliEntrypoint: input.ultrafuzzCliEntrypoint ?? fakeUltrafuzzCliEntrypoint(input.projectRoot)
  };
}

function startRun(input: Parameters<typeof runtimeStartRun>[0]): ReturnType<typeof runtimeStartRun> {
  return runtimeStartRun(withFakeCliEntrypoint(input));
}

function resumeRun(input: Parameters<typeof runtimeResumeRun>[0]): ReturnType<typeof runtimeResumeRun> {
  return runtimeResumeRun(withFakeCliEntrypoint(input));
}

function replayRun(input: Parameters<typeof runtimeReplayRun>[0]): ReturnType<typeof runtimeReplayRun> {
  return runtimeReplayRun(withFakeCliEntrypoint(input));
}

function forkRun(input: Parameters<typeof runtimeForkRun>[0]): ReturnType<typeof runtimeForkRun> {
  return runtimeForkRun(withFakeCliEntrypoint(input));
}

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
    fs.realpathSync(path.join(process.cwd(), "node_modules", "smthrs", "src", "index.js"))
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
    .replace('from "smthrs"', `from ${JSON.stringify(smithersUrl)}`)
    .replace('from "./toml"', 'from "./toml.mjs"')
    .replace('from "./strict-json"', 'from "./strict-json.mjs"')
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
  fs.writeFileSync(
    path.join(fixture, "strict-json.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "strict-json.ts"), "utf8")),
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
      env?: Record<string, string>;
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
    fs.realpathSync(path.join(process.cwd(), "node_modules", "smthrs", "src", "index.js"))
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
    .replace('from "smthrs"', `from ${JSON.stringify(smithersUrl)}`)
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
      buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
        args: string[];
        env?: Record<string, string>;
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

async function loadGeneratedOpenRouterAgent(project: string): Promise<{
  createOpenRouterAgent(options?: Record<string, unknown>): {
    opts: Record<string, unknown> & { env?: Record<string, string> };
    buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
      command?: string;
      args: string[];
      env?: Record<string, string>;
      outputFormat?: string;
      cleanup?: () => Promise<void>;
    }>;
  };
}> {
  const fixture = path.join(project, "openrouter-agent-executable-test");
  fs.mkdirSync(fixture, { recursive: true });
  const agentsDir = path.join(project, ".smithers", "agents");
  const smithersUrl = pathToFileURL(
    fs.realpathSync(path.join(process.cwd(), "node_modules", "smthrs", "src", "index.js"))
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
    .replace('from "smthrs"', `from ${JSON.stringify(smithersUrl)}`)
    .replace('from "./toml"', 'from "./toml.mjs"')
    .replace('from "./environment"', 'from "./environment.mjs"');
  const openRouterSource = fs
    .readFileSync(path.join(agentsDir, "openrouter.ts"), "utf8")
    .replace('from "./codex"', 'from "./codex.mjs"')
    .replace('from "./toml"', 'from "./toml.mjs"')
    .replace('from "./environment"', 'from "./environment.mjs"');
  fs.writeFileSync(path.join(fixture, "codex.mjs"), transpile(codexSource), "utf8");
  fs.writeFileSync(path.join(fixture, "openrouter.mjs"), transpile(openRouterSource), "utf8");
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
  return (await import(pathToFileURL(path.join(fixture, "openrouter.mjs")).href)) as {
    createOpenRouterAgent(options?: Record<string, unknown>): {
      opts: Record<string, unknown> & { env?: Record<string, string> };
      buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
        command?: string;
        args: string[];
        env?: Record<string, string>;
        outputFormat?: string;
        cleanup?: () => Promise<void>;
      }>;
    };
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
    fs.realpathSync(path.join(process.cwd(), "node_modules", "smthrs", "src", "index.js"))
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
    .replace('from "smthrs"', `from ${JSON.stringify(smithersUrl)}`)
    .replace('from "./toml"', 'from "./toml.mjs"')
    .replace('from "./strict-json"', 'from "./strict-json.mjs"')
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
  fs.writeFileSync(
    path.join(fixture, "strict-json.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "strict-json.ts"), "utf8")),
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
  const packageRoot = path.join(project, ".smithers", "node_modules", "smthrs");
  return {
    packageRoot,
    packageJson: path.join(packageRoot, "package.json"),
    target: path.join(packageRoot, ...SMITHERS_BIN_PATH.split("/")),
    shim: path.join(project, ".smithers", "node_modules", ".bin", "smithers")
  };
}

function writeFakeInstalledSmithersDependencies(project: string): void {
  const dependencies = [
    ["@moonshot-ai/kimi-code", KIMI_CODE_VERSION],
    ["@smthrs/tool-context", SMITHERS_VERSION],
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
      name: "smthrs",
      version: input.version ?? SMITHERS_VERSION,
      bin: { smithers: input.binTarget ?? SMITHERS_BIN_PATH }
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
  const storeRoot = path.join(project, ".smithers", "node_modules", ".pnpm", "smthrs@unit", "node_modules", "smthrs");
  const storePackageJson = path.join(storeRoot, "package.json");
  const storeTarget = path.join(storeRoot, ...SMITHERS_BIN_PATH.split("/"));
  fs.mkdirSync(path.dirname(storeTarget), { recursive: true });
  fs.mkdirSync(path.dirname(paths.shim), { recursive: true });
  fs.writeFileSync(
    storePackageJson,
    `${JSON.stringify({
      name: "smthrs",
      version: SMITHERS_VERSION,
      bin: { smithers: SMITHERS_BIN_PATH }
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
        name: "smthrs",
        version: SMITHERS_VERSION,
        bin: { smithers: SMITHERS_BIN_PATH }
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
      'if [ -n "$SMITHERS_FAKE_OPENROUTER_ENV_LOG" ]; then',
      '  printf \'%s|%s|%s\\n\' "$OPENROUTER_API_KEY" "$OPENAI_API_KEY" "$ANTHROPIC_API_KEY" > "$SMITHERS_FAKE_OPENROUTER_ENV_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_RETRY_CREDENTIAL_ENV_LOG" ]; then',
      '  printf \'%s|%s\\n\' "$OPENAI_API_KEY" "$DEEPSEEK_API_KEY" > "$SMITHERS_FAKE_RETRY_CREDENTIAL_ENV_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_CONTEXT_LOG" ]; then',
      '  printf \'%s|%s|%s|%s|%s|%s\\n\' "$SMITHERS_RUN_ID" "$SMITHERS_NODE_ID" "$SMITHERS_ATTEMPT" "$SMITHERS_ITERATION" "$SMITHERS_CLI_SRC_DIR" "$SMITHERS_SNAPSHOT_SOCK" > "$SMITHERS_FAKE_CONTEXT_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_KEEP_WORKTREES_LOG" ]; then',
      '  printf \'%s\\n\' "$SMITHERS_KEEP_WORKTREES" > "$SMITHERS_FAKE_KEEP_WORKTREES_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_ADMISSION_TIMEOUT_LOG" ]; then',
      '  printf \'%s\\n\' "$SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS" > "$SMITHERS_FAKE_ADMISSION_TIMEOUT_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_FORGE_GUARD_LOG" ]; then',
      '  command -v forge > "$SMITHERS_FAKE_FORGE_GUARD_LOG"',
      "fi",
      'case "$1" in',
      "  fork)",
      '    printf \'%s\\n\' \'{"ok":true,"data":{"forkedRunId":"ultrafuzz-lifecycle-run-forked"}}\'',
      "    ;;",
      "  replay)",
      '    printf \'%s\\n\' \'{"ok":true,"data":{"forkedRunId":"ultrafuzz-lifecycle-run-replayed"}}\'',
      "    ;;",
      "  pause)",
      '    if [ -n "$SMITHERS_FAKE_PAUSE_EMPTY_SUCCESS" ]; then',
      "      exit 0",
      '    elif [ -n "$SMITHERS_FAKE_ALREADY_PAUSED" ]; then',
      '      printf \'%s\\n\' \'{"ok":true,"data":{"status":"paused"}}\'',
      "    else",
      '      printf \'%s\\n\' \'{"ok":true,"data":{"status":"pause-requested"}}\'',
      "      exit 2",
      "    fi",
      "    ;;",
      "  inspect)",
      '    printf \'{"ok":true,"data":{"run":{"id":"%s","workflow":"%s","status":"running","started":"2026-07-03T00:00:00.000Z","elapsed":"0s"},"runState":{"runId":"%s","state":"running","computedAt":"2026-07-03T00:00:03.000Z"},"steps":[],"nodes":[]},"meta":{"command":"inspect","duration":"1ms"}}\\n\' "$2" "$2" "$2"',
      "    ;;",
      "  ps)",
      '    case "$*" in',
      '      *--full-output*) printf \'%s\\n\' \'{"ok":true,"data":{"runs":[]},"meta":{"command":"ps","duration":"1ms"}}\' ;;',
      "      *) printf '%s\\n' '{\"runs\":[]}' ;;",
      "    esac",
      "    ;;",
      "  events)",
      '    case "$*" in',
      '      *--full-output*) printf \'%s\\n\' \'{"ok":true,"data":[],"meta":{"command":"events","duration":"1ms"}}\' ;;',
      "    esac",
      "    ;;",
      "  status)",
      '    if [ -n "$SMITHERS_FAKE_STATUS_JSON" ]; then',
      "      printf '%s\\n' \"$SMITHERS_FAKE_STATUS_JSON\"",
      "    else",
      // The runner emits its envelope only under --full-output, and emits the bare
      // document otherwise. A fake that always enveloped hid a caller that never
      // asked for one.
      '      case "$*" in',
      `        *--full-output*) printf '%s\\n' ${shellQuote(JSON.stringify(currentStatusEnvelope()))} | sed "s/__RUN_ID__/$2/g" ;;`,
      `        *) printf '%s\\n' ${shellQuote(JSON.stringify((currentStatusEnvelope() as { data: unknown }).data))} | sed "s/__RUN_ID__/$2/g" ;;`,
      "      esac",
      "    fi",
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

function currentPsEnvelope(runs: unknown[]): unknown {
  return {
    ok: true,
    data: { runs },
    meta: { command: "ps", duration: "1ms" }
  };
}

function currentStatusEnvelope(workflowRunId = "__RUN_ID__"): Record<string, unknown> {
  return {
    ok: true,
    data: {
      status: "running",
      verdict: "running-healthy",
      reason: "1 running, 2 finished in last 10m",
      counts: {
        finished: 2,
        inProgress: 1,
        pending: 3,
        failed: 0,
        waitingApproval: 0,
        waitingEvent: 0,
        waitingTimer: 0,
        skipped: 0,
        other: 0,
        total: 6
      },
      modelMix: [{ engine: "codex", model: "gpt-test", attempts: 3, quotaParked: false }],
      throughput: { recentFinished: 2, windowMs: 600_000, totalFinished: 2, lastFinishedAtMs: 1_000 },
      bottleneck: [{ nodeId: "project-discovery", iteration: 0, state: "in-progress", detail: "running 1m" }],
      bottleneckOmitted: 0,
      quota: null,
      // The pinned runner names the run and its liveness alongside the health
      // fields; this fixture mirrors a document captured from a real run.
      runId: workflowRunId,
      workflow: workflowRunId,
      liveness: { state: "running" },
      startedAtMs: 1_000,
      finishedAtMs: null,
      generatedAtMs: 2_000
    },
    meta: { command: "status", duration: "1ms" }
  };
}

function fakePsSmithersEnv(project: string, ps: unknown): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-ps-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const psPath = path.join(project, "fake-smithers-ps.json");
  fs.writeFileSync(psPath, `${JSON.stringify(ps, null, 2)}\n`, "utf8");
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    ["#!/bin/sh", 'if [ "$1" = "ps" ]; then', '  cat "$SMITHERS_FAKE_PS"', "  exit 0", "fi", "exit 1", ""].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: smithers,
    SMITHERS_FAKE_PS: psPath
  };
}

function fakeLifecycleSmithersEnv(
  project: string,
  input: {
    inspect: unknown;
    events?: string;
    tokenEvents?: string;
    inspectMarkerPath?: string;
    timeline?: unknown;
    statusEvents?: unknown;
    attemptSelections?: Record<string, Record<number, { chainIndex: number; profileId: string; model: string | null }>>;
  }
): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const inspectPath = path.join(project, "fake-smithers-inspect.json");
  const eventsPath = path.join(project, "fake-smithers-events.ndjson");
  const tokenEventsPath =
    input.tokenEvents === undefined ? eventsPath : path.join(project, "fake-smithers-token-events.ndjson");
  const timelinePath = path.join(project, "fake-smithers-timeline.json");
  const statusEventsPath = path.join(project, "fake-smithers-status-events.json");
  const nodeDetailsDirectory = path.join(project, "fake-smithers-node-details");
  fs.writeFileSync(inspectPath, `${JSON.stringify(input.inspect, null, 2)}\n`, "utf8");
  fs.writeFileSync(eventsPath, input.events ?? "", "utf8");
  if (input.tokenEvents !== undefined) fs.writeFileSync(tokenEventsPath, input.tokenEvents, "utf8");
  fs.writeFileSync(
    timelinePath,
    `${JSON.stringify(input.timeline ?? { timeline: { frames: [] } }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    statusEventsPath,
    `${JSON.stringify(
      input.statusEvents ?? { ok: true, data: [], meta: { command: "events", duration: "1ms" } },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.mkdirSync(nodeDetailsDirectory, { recursive: true });
  const terminalAttempts = new Map<string, Array<{ attempt: number; state: "finished" | "failed" }>>();
  for (const line of (input.events ?? "").trim().split("\n").filter(Boolean)) {
    const event = JSON.parse(line) as { type?: unknown; payload?: Record<string, unknown> };
    if (event.type !== "NodeFinished" && event.type !== "NodeFailed") continue;
    const nodeId = event.payload?.nodeId;
    const attempt = event.payload?.attempt;
    if (typeof nodeId !== "string" || !nodeId.startsWith("node:") || typeof attempt !== "number") continue;
    const rows = terminalAttempts.get(nodeId) ?? [];
    rows.push({ attempt, state: event.type === "NodeFinished" ? "finished" : "failed" });
    terminalAttempts.set(nodeId, rows);
  }
  for (const [nodeId, attempts] of terminalAttempts) {
    const attemptId = nodeId.slice("node:".length);
    const rows = attempts.map(({ attempt, state }) => {
      const selection = input.attemptSelections?.[nodeId]?.[attempt] ?? {
        chainIndex: 0,
        profileId: "default",
        model: "gpt-5.5"
      };
      return {
        nodeId,
        attempt,
        state,
        meta: {
          agentChainIndex: selection.chainIndex,
          agentId: `ultrafuzz-agent:${attemptId}:${selection.chainIndex}:${selection.profileId}`,
          agentModel: selection.model
        }
      };
    });
    fs.writeFileSync(
      path.join(nodeDetailsDirectory, `${nodeId}.json`),
      `${JSON.stringify({ node: { nodeId, lastAttempt: Math.max(...rows.map((row) => row.attempt)) }, attempts: rows })}\n`,
      "utf8"
    );
  }
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
      "  node)",
      '    cat "$SMITHERS_FAKE_NODE_DETAILS/$2.json"',
      "    ;;",
      "  cancel)",
      '    printf \'%s\\n\' \'{"ok":true,"data":{"status":"cancel-requested"}}\'',
      "    exit 2",
      "    ;;",
      "  events)",
      '    case "$*" in',
      '      *--full-output*) cat "$SMITHERS_FAKE_STATUS_EVENTS" ;;',
      '      *) if [ "$3" = "--type" ] && [ "$4" = "token" ]; then',
      '           cat "$SMITHERS_FAKE_TOKEN_EVENTS"',
      "         else",
      '           cat "$SMITHERS_FAKE_EVENTS"',
      "         fi ;;",
      "    esac",
      "    ;;",
      "  timeline)",
      '    cat "$SMITHERS_FAKE_TIMELINE"',
      "    ;;",
      "  rewind)",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "  fork)",
      '    if [ -n "$SMITHERS_FAKE_FORKED_RUN_ID" ]; then',
      '      printf \'{"ok":true,"data":{"forkedRunId":"%s"}}\\n\' "$SMITHERS_FAKE_FORKED_RUN_ID"',
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
    SMITHERS_FAKE_STATUS_EVENTS: statusEventsPath,
    SMITHERS_FAKE_TIMELINE: timelinePath,
    SMITHERS_FAKE_NODE_DETAILS: nodeDetailsDirectory,
    ULTRAFUZZ_PRICING_CATALOG_URL: "off"
  };
}

function pricingCatalogDataUrl(catalog: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(catalog))}`;
}

type TestSmithersRunStatus = (typeof SMITHERS_RUN_STATUSES)[number];
type TestSmithersRunState = Exclude<(typeof SMITHERS_RUN_STATES)[number], "unknown">;
type TestSmithersNodeState = (typeof SMITHERS_NODE_STATES)[number];

function workflowInspect(input: {
  workflowRunId: string;
  status?: TestSmithersRunStatus;
  state?: TestSmithersRunState;
  error?: unknown;
  failedChildKeys?: string[];
  exhaustedLoops?: Array<{ id: string; iteration: number; maxIterations: number | null }>;
  steers?: Array<Record<string, unknown>>;
  includeVerifierSteps?: boolean;
  steps: Array<{ id: string; state: TestSmithersNodeState; attempt?: number }>;
}): unknown {
  const explicitStepIds = new Set(input.steps.map((step) => step.id));
  const taskRows =
    input.includeVerifierSteps === false
      ? input.steps
      : input.steps.flatMap((step) => {
          if (!step.id.startsWith("node:") || step.state !== "finished") {
            return [step];
          }
          const verifierId = `verify:${step.id.slice("node:".length)}`;
          return explicitStepIds.has(verifierId)
            ? [step]
            : [step, { id: verifierId, state: "finished", attempt: step.attempt }];
        });
  const steps = taskRows.map((step) => ({
    id: step.id,
    state: step.state,
    attempt: step.attempt ?? 0,
    label: step.id
  }));
  const nodes = taskRows.map((step) => ({
    nodeId: step.id,
    state: step.state,
    attempt: step.attempt ?? 0,
    label: step.id
  }));
  return {
    ok: true,
    data: {
      run: {
        id: input.workflowRunId,
        workflow: input.workflowRunId,
        status: input.status ?? "finished",
        ...(input.error === undefined ? {} : { error: input.error }),
        started: "2026-07-03T00:00:00.000Z",
        elapsed: "2s",
        finished: input.status === "running" ? undefined : "2026-07-03T00:00:02.000Z"
      },
      runState: {
        runId: input.workflowRunId,
        computedAt: "2026-07-03T00:00:03.000Z",
        state: input.state ?? (input.status === "running" ? "running" : "succeeded")
      },
      ...(input.failedChildKeys === undefined || input.failedChildKeys.length === 0
        ? {}
        : { failedChildren: input.failedChildKeys.length, failedChildKeys: input.failedChildKeys }),
      ...(input.exhaustedLoops === undefined ? {} : { exhaustedLoops: input.exhaustedLoops }),
      ...(input.steers === undefined ? {} : { steers: input.steers }),
      steps,
      nodes
    },
    meta: {
      command: "inspect",
      duration: "1ms"
    }
  };
}

function workflowEvents(
  workflowRunId: string,
  events: Array<{
    type: string;
    nodeId?: string;
    iteration?: number;
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
      if (
        event.type.startsWith("Node") ||
        event.type === "TaskHeartbeatTimeout" ||
        event.type === "TokenUsageReported"
      ) {
        payload.iteration = event.iteration ?? 0;
      }
      if (
        [
          "NodeStarted",
          "NodeFinished",
          "NodeFailed",
          "NodeRetrying",
          "TaskHeartbeatTimeout",
          "TokenUsageReported"
        ].includes(event.type)
      ) {
        payload.attempt = event.attempt ?? 1;
      } else if (event.type === "NodeCancelled" && event.attempt !== undefined) {
        payload.attempt = event.attempt;
      }
      if (event.type === "RunFailed" || event.type === "NodeFailed") {
        payload.error = event.error ?? { message: "test workflow failure" };
      } else if (event.error !== undefined) {
        payload.error = event.error;
      }
      if (event.type === "TaskHeartbeatTimeout") {
        payload.lastHeartbeatAtMs = timestampMs - 1_000;
        payload.timeoutMs = 1_000;
      }
      if (event.type === "RunAutoResumed") {
        payload.lastHeartbeatAtMs = timestampMs - 1_000;
        payload.staleDurationMs = 1_000;
      }
      if (event.type === "TokenUsageReported") {
        payload.model = "test-model";
        payload.agent = "test-agent";
        payload.inputTokens = 0;
        payload.outputTokens = 0;
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
            schema_version: "ultrafuzz.finding.v2",
            id: `finding-${nodeId}`,
            title: "Candidate issue",
            status: "candidate",
            severity_guess: "Medium",
            confidence: "medium",
            summary: "The generated evidence needs review.",
            source_node_id: nodeId
          }
        ])
      : `artifact for ${nodeId}\n`;
    fs.writeFileSync(filePath, contents, "utf8");
  }
  writeCurrentArtifactVerificationMarker(runRoot, nodeId);
}

function writeCurrentArtifactVerificationMarker(runRoot: string, attemptId: string): void {
  const tasksPath = path.join(runRoot, "smithers", "tasks.json");
  if (!fs.existsSync(tasksPath)) return;
  const document = JSON.parse(fs.readFileSync(tasksPath, "utf8")) as {
    tasks?: Array<{
      attemptId?: string;
      logicalNodeId?: string;
      metadata?: {
        artifacts?: {
          outputs?: Array<{
            path: string;
            contract: string;
            contractDigest: string;
            schemaFile?: string;
            schemaId?: string;
            schemaSha256?: string;
            schemaBundleSha256?: string;
            validatorBuild?: string;
            primary: boolean;
          }>;
        };
      };
    }>;
  };
  const task = document.tasks?.find((candidate) => candidate.attemptId === attemptId);
  const outputs = task?.metadata?.artifacts?.outputs;
  if (task?.logicalNodeId === undefined || outputs === undefined || outputs.length === 0) return;
  const artifactDir = path.join(runRoot, "artifacts", attemptId);
  const snapshots = outputs.map((output) => {
    const artifactPath = path.join(artifactDir, ...output.path.split("/"));
    if (!fs.existsSync(artifactPath)) return undefined;
    const bytes = fs.readFileSync(artifactPath);
    return { output, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  });
  if (snapshots.some((snapshot) => snapshot === undefined)) return;
  const verified = snapshots.filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== undefined);
  const marker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: attemptId,
    node_id: task.logicalNodeId,
    artifacts: verified.map(({ output, sha256 }) => ({
      path: output.path,
      contract: output.contract,
      contract_digest: output.contractDigest,
      ...(output.schemaFile === undefined
        ? {}
        : {
            schema_file: output.schemaFile,
            schema_id: output.schemaId,
            schema_sha256: output.schemaSha256,
            schema_bundle_sha256: output.schemaBundleSha256,
            validator_build: output.validatorBuild
          }),
      sha256,
      primary: output.primary
    })),
    publications: verified.map(({ output, sha256 }) => ({ path: output.path, sha256 }))
  };
  const markerRoot = path.join(runRoot, ".ultrafuzz-verification");
  fs.mkdirSync(markerRoot, { recursive: true });
  fs.writeFileSync(path.join(markerRoot, `${attemptId}.json`), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

const GENERIC_RUNTIME_MARKDOWN_PATH = "setup/runtime-fixture.md";
const REPORT_VOCABULARY_PROMPT_REFERENCES = "\n{{finding_reachability_vocabulary}}\n{{finding_note_key_vocabulary}}\n";

function writeSmallTopology(project: string, discoveryMarkdownPath = "setup/project-discovery.md"): void {
  const discoveryPromptPath =
    discoveryMarkdownPath === GENERIC_RUNTIME_MARKDOWN_PATH ? "setup/runtime-fixture.md" : "setup/project-discovery.md";
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
    prompt: ${discoveryPromptPath}
    depends_on:
      - __start__
    outputs:
      - path: ${discoveryMarkdownPath}
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: findings.json
        contract: ultrafuzz/findings@2
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
  if (discoveryMarkdownPath === GENERIC_RUNTIME_MARKDOWN_PATH) writeNeutralRuntimeFixturePrompt(project);
  fs.appendFileSync(
    path.join(project, ".ultrafuzz", "prompts", discoveryPromptPath),
    REPORT_VOCABULARY_PROMPT_REFERENCES,
    "utf8"
  );
}

async function compileInvariantCampaignBudgetFixture(input: {
  logicalNodeId: string;
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
  const definition = artifactContractDefinition("ultrafuzz/invariant-campaign-plan@2");
  const binding = artifactContractSchemaBinding("ultrafuzz/invariant-campaign-plan@2");
  assert.notEqual(binding, undefined);
  node!.outputs.push({
    path: "campaign-plan.json",
    contract: "ultrafuzz/invariant-campaign-plan@2",
    contractDigest: definition.digest,
    primary: false,
    schemaFile: binding!.schema_file,
    schemaId: binding!.schema_id,
    schemaSha256: binding!.schema_sha256,
    schemaBundleSha256: binding!.schema_bundle_sha256,
    validatorBuild: binding!.validator_build
  });
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

function writeOutOfOrderTopology(project: string, discoveryMarkdownPath = "setup/project-discovery.md"): void {
  const discoveryPromptPath =
    discoveryMarkdownPath === GENERIC_RUNTIME_MARKDOWN_PATH ? "setup/runtime-fixture.md" : "setup/project-discovery.md";
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
    prompt: ${discoveryPromptPath}
    depends_on:
      - __start__
    outputs:
      - path: ${discoveryMarkdownPath}
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
  if (discoveryMarkdownPath === GENERIC_RUNTIME_MARKDOWN_PATH) writeNeutralRuntimeFixturePrompt(project);
}

function writeNeutralRuntimeFixturePrompt(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "setup", "runtime-fixture.md"),
    `---
id: runtime-fixture
display_name: Runtime Fixture
---

Write the neutral runtime handoff to
{{artifact_path}}/${GENERIC_RUNTIME_MARKDOWN_PATH}.
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
        contract: ultrafuzz/reference-manifest@1
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
        contract: ultrafuzz/findings@2
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
{{finding_reachability_vocabulary}}
{{finding_note_key_vocabulary}}
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
        schema_version: REFERENCE_CACHE_SCHEMA_VERSION,
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

function writeFanoutProject(project: string, discoveryMarkdownPath = "setup/project-discovery.md"): void {
  fs.mkdirSync(path.join(project, ".ultrafuzz", "workspaces"), { recursive: true });
  fs.mkdirSync(path.join(project, ".ultrafuzz", "prompts", "setup"), { recursive: true });
  fs.mkdirSync(path.join(project, ".ultrafuzz", "prompts", "strategies"), { recursive: true });
  fs.mkdirSync(path.join(project, ".smithers", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".smithers", "agents", "index.ts"),
    "const createAgent = () => null;\n" +
      "export const agentFactories = {\n" +
      "  ClaudeAgent: createAgent,\n" +
      "  CodexAgent: createAgent,\n" +
      "  DeepSeekAgent: createAgent,\n" +
      "  KimiAgent: createAgent,\n" +
      "  OpenRouterAgent: createAgent\n" +
      "};\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, "ultrafuzz.toml"),
    `schema_version = "ultrafuzz.config.v2"

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
      - path: ${discoveryMarkdownPath}
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: findings.json
        contract: ultrafuzz/findings@2
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
        contract: ultrafuzz/findings@2
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
{{finding_reachability_vocabulary}}
{{finding_note_key_vocabulary}}
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
{{artifact_path:project-discovery}}/${discoveryMarkdownPath}

Current findings: {{output_findings_path}}
{{finding_reachability_vocabulary}}
{{finding_note_key_vocabulary}}
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
      const preserved = initProject({ projectRoot: project });
      assert.equal(preserved.ok, true, JSON.stringify(preserved.diagnostics));
      assert.equal(fs.readFileSync(codexPath, "utf8"), V0_0_2_STOCK_CODEX_ADAPTER);

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
  assert.equal(smithersPackage.dependencies?.["smthrs"], SMITHERS_VERSION);
  assert.equal(smithersPackage.overrides?.effect, SMITHERS_EFFECT_VERSION);
  const codexAgentText = fs.readFileSync(path.join(project, ".smithers/agents/codex.ts"), "utf8");
  assert.doesNotMatch(codexAgentText, /cwd:\s*process\.cwd/);
  assert.doesNotMatch(codexAgentText, /apiKey:\s*process\.env\.OPENAI_API_KEY/);
  assert.match(codexAgentText, /ultrafuzz\.toml/);
  assert.match(codexAgentText, /codexAuthOptions/);
  // The TOML parser is shared, so a fix reaches every backend at once.
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/toml.ts")), true);
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/strict-json.ts")), true);
  const tomlHelperText = fs.readFileSync(path.join(project, ".smithers/agents/toml.ts"), "utf8");
  assert.match(codexAgentText, /import \{ readRootStringTable, readStringTable, stringField \} from ".\/toml";/);
  assert.doesNotMatch(codexAgentText, /function readStringTable/);
  assert.match(tomlHelperText, /export function readRootStringTable/);
  // TOML's \UXXXXXXXX has no JSON equivalent, so values are not JSON.parse'd.
  assert.doesNotMatch(tomlHelperText, /JSON\.parse/);
  assert.match(tomlHelperText, /escape !== "u" && escape !== "U"/);
  assert.match(codexAgentText, /const apiKey = requiredEnv/);
  assert.match(codexAgentText, /return { apiKey, env: { CODEX_API_KEY: apiKey } }/);
  assert.match(codexAgentText, /const env: Record<string, string> = { OPENAI_API_KEY: "", CODEX_API_KEY: "" };/);
  assert.match(codexAgentText, /function codexProviderBaseUrl/);
  assert.match(codexAgentText, /process\.env\.OPENAI_BASE_URL/);
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
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/openrouter.ts")), true);
  const agentsIndexText = fs.readFileSync(path.join(project, ".smithers/agents/index.ts"), "utf8");
  assert.match(agentsIndexText, /export \{ createCodexAgent \} from ".\/codex";/);
  assert.match(agentsIndexText, /export \{ createClaudeAgent \} from ".\/claude";/);
  assert.match(agentsIndexText, /export \{ createDeepSeekAgent \} from ".\/deepseek";/);
  assert.match(agentsIndexText, /export \{ createKimiAgent \} from ".\/kimi";/);
  assert.match(agentsIndexText, /export \{ createOpenRouterAgent \} from ".\/openrouter";/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*ClaudeAgent: createClaudeAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*CodexAgent: createCodexAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*DeepSeekAgent: createDeepSeekAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*KimiAgent: createKimiAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*OpenRouterAgent: createOpenRouterAgent/);
  // Importing the registry must not construct any agent: doing so reads that
  // agent's auth and fails a project that only uses the other backend.
  assert.doesNotMatch(agentsIndexText, /=\s*create(Codex|Claude|DeepSeek|Kimi|OpenRouter)Agent\(\)/);
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
  assert.match(deepSeekAgentText, /import \{ parseStrictJson \} from "\.\/strict-json";/u);
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

  const validate = await validateProject({ projectRoot: project, env: {} });
  assert.equal(validate.ok, true, JSON.stringify(validate.diagnostics));
  assert.equal(validate.value?.policy_posture.trust.status, "pass");
  assert.equal(validate.value?.policy_posture.agents.status, "pass");
  assert.equal(validate.value?.policy_posture.paths.status, "pass");
  assert.equal(validate.value?.resolved_config?.default_agent, "CodexAgent");
  assert.equal(validate.value?.resolved_config?.default_model, "gpt-5.5");
  assert.equal(validate.value?.resolved_config?.default_reasoning, "xhigh");
});

test("non-force init preserves historical stock agent adapters and force replaces them", () => {
  assert.equal(
    crypto.createHash("sha256").update(V0_0_2_STOCK_CODEX_ADAPTER).digest("hex"),
    "26dae14e43c09dbe7901aa731cd552b282d502d86cea8cc6726e4a8579cd3236"
  );
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const codexPath = path.join(project, ".smithers", "agents", "codex.ts");
  const currentAdapter = fs.readFileSync(codexPath, "utf8");
  fs.writeFileSync(codexPath, V0_0_2_STOCK_CODEX_ADAPTER, "utf8");
  const historicalStats = fs.statSync(codexPath, { bigint: true });

  const preserved = initProject({ projectRoot: project });

  assert.equal(preserved.ok, true, JSON.stringify(preserved.diagnostics));
  assert.equal(fs.readFileSync(codexPath, "utf8"), V0_0_2_STOCK_CODEX_ADAPTER);
  assert.equal(fs.statSync(codexPath, { bigint: true }).ino, historicalStats.ino);
  const forced = initProject({ projectRoot: project, force: true });
  assert.equal(forced.ok, true, JSON.stringify(forced.diagnostics));
  assert.equal(fs.readFileSync(codexPath, "utf8"), currentAdapter);
});

test("non-force init migrates the exact generated 0.32 package and immediately prior stock adapters", () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const manifestPath = path.join(project, ".smithers", "package.json");
  const oldManifest = {
    name: "ultrafuzz-smithers",
    private: true,
    type: "module",
    dependencies: {
      "@moonshot-ai/kimi-code": "0.29.1",
      "smithers-orchestrator": "0.32.0",
      zod: "4.4.3",
      "custom-agent-package": "1.2.3"
    },
    devDependencies: { typescript: "6.0.3" },
    overrides: {
      effect: "4.0.0-beta.102",
      "@effect/opentelemetry": "4.0.0-beta.102",
      "@effect/platform-bun": "4.0.0-beta.102",
      "@effect/platform-node-shared": "4.0.0-beta.102",
      "@effect/sql-sqlite-bun": "4.0.0-beta.102"
    }
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(oldManifest, null, 2)}\n`, "utf8");
  const codexPath = path.join(project, ".smithers", "agents", "codex.ts");
  const stock032Source = fs
    .readFileSync(codexPath, "utf8")
    .replaceAll("@smthrs/agents", "@smithers-orchestrator/agents")
    .replaceAll('from "smthrs"', 'from "smithers-orchestrator"');
  assert.equal(
    crypto.createHash("sha256").update(stock032Source).digest("hex"),
    "b932fb7da3c05fdc662f60359e8a751aaabd236ca4072dfeaade1a7bb25a01b5"
  );
  fs.writeFileSync(codexPath, stock032Source, "utf8");

  const upgraded = initProject({ projectRoot: project });

  assert.equal(upgraded.ok, true, JSON.stringify(upgraded.diagnostics));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(manifest.dependencies["smithers-orchestrator"], undefined);
  assert.equal(manifest.dependencies.smthrs, "0.34.0");
  assert.equal(manifest.dependencies["custom-agent-package"], "1.2.3");
  const source = fs.readFileSync(codexPath, "utf8");
  assert.match(source, /from "(?:smthrs|@smthrs\/agents)"/u);
  assert.doesNotMatch(source, /smithers-orchestrator/u);
});

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
          if (codexOpenCount === 1) {
            throw Object.assign(new Error("induced sensitive adapter inspection failure"), { code: "EACCES" });
          }
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      }
    });
    try {
      const preserved = initProject({ projectRoot: project });
      assert.equal(preserved.ok, true, JSON.stringify(preserved.diagnostics));
      assert.equal(codexOpenCount, 1);
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

test("non-force init never follows or overwrites linked adapter paths", () => {
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

test("startRun gives manual update guidance for a customized stale adapter", async () => {
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
  assert.match(run.diagnostics[0]?.message ?? "", /update this adapter manually/u);
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

      // An operator-supplied route always wins.
      process.env.OPENAI_BASE_URL = "https://operator.example/v1";
      assert.equal(agentEnvironment().OPENAI_BASE_URL, undefined);
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
  "generated OpenRouter adapter preserves opaque model IDs and enables the authenticated provider catalogue",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const configPath = path.join(project, "ultrafuzz.toml");
    const codexHome = path.join(project, ".ultrafuzz", "openrouter-test-codex");
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace(
          '[agents.OpenRouterAgent]\nauth = "api-key"\napi_key_env = "OPENROUTER_API_KEY"',
          `[agents.OpenRouterAgent]\nauth = "api-key"\napi_key_env = "ROUTER_ALIAS"\nconfig_dir = ${JSON.stringify(codexHome)}`
        ),
      "utf8"
    );
    const { createOpenRouterAgent } = await loadGeneratedOpenRouterAgent(project);
    const model = "~vendor/model.latest:free+preview@2026";
    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      alias: process.env.ROUTER_ALIAS,
      openrouter: process.env.OPENROUTER_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.ROUTER_ALIAS = "deterministic-openrouter-test-key";
    process.env.OPENROUTER_API_KEY = "unselected-openrouter-key";
    process.env.OPENAI_API_KEY = "unrelated-openai-key";
    process.env.ANTHROPIC_API_KEY = "unrelated-anthropic-key";
    process.env.OPENAI_BASE_URL = "https://ambient-route.invalid/v1";
    try {
      const agent = createOpenRouterAgent({
        model,
        reasoningEffort: "high",
        addDir: ["/tmp/artifacts", "/tmp/dependency artifacts"]
      });
      assert.deepEqual(agent.opts.config, { model_reasoning_effort: "high" });
      const command = await agent.buildCommand({ prompt: "Contract only", cwd: project, options: {} });
      assert.equal(command.command, "codex");
      const modelIndex = command.args.indexOf("--model");
      assert.equal(modelIndex >= 0, true);
      assert.equal(command.args[modelIndex + 1], model);
      assert.equal(command.args.filter((value) => value === model).length, 1);
      const firstAddDir = command.args.indexOf("--add-dir");
      assert.deepEqual(command.args.slice(firstAddDir, firstAddDir + 4), [
        "--add-dir",
        "/tmp/artifacts",
        "--add-dir",
        "/tmp/dependency artifacts"
      ]);
      assert.equal(command.outputFormat, "stream-json");
      assert.equal(command.env?.ROUTER_ALIAS, "deterministic-openrouter-test-key");
      assert.equal(command.env?.OPENROUTER_API_KEY, "");
      assert.equal(command.env?.OPENAI_API_KEY, "deterministic-openrouter-test-key");
      assert.equal(command.env?.CODEX_API_KEY, "");
      assert.equal(command.env?.OPENAI_BASE_URL, "https://openrouter.ai/api/v1");
      assert.equal(command.env?.ANTHROPIC_API_KEY, "");
      assert.equal(command.env?.CODEX_HOME, codexHome);
      await command.cleanup?.();

      const providerConfig = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
      assert.equal(
        providerConfig,
        [
          'model_provider = "openrouter"',
          "",
          "[model_providers.openrouter]",
          'name = "OpenRouter"',
          'base_url = "https://openrouter.ai/api/v1"',
          'wire_api = "responses"',
          "",
          "[model_providers.openrouter.auth]",
          'command = "node"',
          'args = ["-e", "process.stdout.write(process.env[process.argv[1]] ?? \'\')", "ROUTER_ALIAS"]',
          ""
        ].join("\n")
      );
      assert.equal(providerConfig.includes("deterministic-openrouter-test-key"), false);
      assert.equal(fs.statSync(codexHome).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(codexHome, "config.toml")).mode & 0o777, 0o600);
    } finally {
      for (const [name, value] of Object.entries({
        ULTRAFUZZ_CONFIG_PATH: previous.config,
        ROUTER_ALIAS: previous.alias,
        OPENROUTER_API_KEY: previous.openrouter,
        OPENAI_API_KEY: previous.openai,
        ANTHROPIC_API_KEY: previous.anthropic,
        OPENAI_BASE_URL: previous.baseUrl
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
);

test("generated OpenRouter adapter fails before materializing config when its dedicated key is missing", async () => {
  if (!runningUnderBun) return;
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  const configPath = path.join(project, "ultrafuzz.toml");
  const { createOpenRouterAgent } = await loadGeneratedOpenRouterAgent(project);
  const previousConfig = process.env.ULTRAFUZZ_CONFIG_PATH;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.throws(() => createOpenRouterAgent(), /OPENROUTER_API_KEY is not set/u);
  } finally {
    if (previousConfig === undefined) delete process.env.ULTRAFUZZ_CONFIG_PATH;
    else process.env.ULTRAFUZZ_CONFIG_PATH = previousConfig;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

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
        prompt_cache_miss_tokens: 120,
        output_tokens: 30,
        prompt_cache_hit_tokens: 400,
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
  "generated DeepSeek adapter rejects ambiguous or noncanonical result telemetry",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { DeepSeekClaudeCodeAgent } = await loadGeneratedDeepSeekAgent(project);
    const agent = new DeepSeekClaudeCodeAgent({ model: "deepseek-v4-pro", ultrafuzzApiKey: "test-key" });
    const interpreter = agent.createOutputInterpreter();

    assert.doesNotThrow(() =>
      interpreter.onStdoutLine?.(JSON.stringify({ type: "assistant", message: { content: "working" } }))
    );
    assert.doesNotThrow(() => interpreter.onStdoutLine?.("provider banner: still starting"));

    const tooDeep = `${"[".repeat(34)}null${"]".repeat(34)}`;
    const invalid = [
      {
        label: "duplicate key",
        line: '{"type":"result","type":"result","usage":{"prompt_cache_miss_tokens":1,"prompt_cache_hit_tokens":2,"output_tokens":3}}',
        expected: /duplicate/iu
      },
      {
        label: "malformed candidate",
        line: '{"type":"result","usage":',
        expected: /invalid strict JSON/iu
      },
      {
        label: "malformed object without result marker",
        line: '{"provider_status":',
        expected: /invalid strict JSON/iu
      },
      {
        label: "legacy aliases",
        line: JSON.stringify({
          type: "result",
          usage: { input_tokens: 1, cache_read_input_tokens: 2, completion_tokens: 3 }
        }),
        expected: /legacy alias/iu
      },
      {
        label: "legacy alias alongside canonical fields",
        line: JSON.stringify({
          type: "result",
          usage: {
            prompt_cache_miss_tokens: 1,
            prompt_cache_hit_tokens: 2,
            output_tokens: 3,
            input_tokens: 1
          }
        }),
        expected: /legacy alias input_tokens/iu
      },
      {
        label: "missing exact field",
        line: JSON.stringify({
          type: "result",
          usage: { prompt_cache_miss_tokens: 1, output_tokens: 3 }
        }),
        expected: /prompt_cache_hit_tokens/iu
      },
      {
        label: "oversize raw line whitespace",
        line:
          " ".repeat(1024 * 1024) +
          JSON.stringify({
            type: "result",
            usage: { prompt_cache_miss_tokens: 1, prompt_cache_hit_tokens: 2, output_tokens: 3 }
          }),
        expected: /1048576-byte limit/iu
      },
      {
        label: "excessive depth",
        line: `{"type":"result","future":${tooDeep},"usage":{"prompt_cache_miss_tokens":1,"prompt_cache_hit_tokens":2,"output_tokens":3}}`,
        expected: /nesting-depth limit of 32/iu
      },
      {
        label: "unsafe aggregate",
        line: JSON.stringify({
          type: "result",
          usage: {
            prompt_cache_miss_tokens: Number.MAX_SAFE_INTEGER,
            prompt_cache_hit_tokens: 1,
            output_tokens: 0
          }
        }),
        expected: /safe integer range/iu
      }
    ];
    for (const fixture of invalid) {
      assert.throws(() => interpreter.onStdoutLine?.(fixture.line), fixture.expected, fixture.label);
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
      pathToFileURL(fs.realpathSync(path.join(process.cwd(), "node_modules", "smthrs", "src", "index.js"))).href
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
    assert.equal(SMITHERS_VERSION, "0.34.0");
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
  "generated Kimi adapter strictly parses credentials and resume hints without normalization",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-strict-credentials");
    const sourceCredential = path.join(sourceConfig, "credentials", "kimi-code.json");
    const sharedHome = path.join(project, "kimi-strict-shared-auth");
    const sharedCredential = path.join(sharedHome, "credentials", "kimi-code.json");
    fs.mkdirSync(path.dirname(sharedCredential), { recursive: true });
    const validTarget = `${JSON.stringify({
      access_token: "target-access",
      refresh_token: "target-refresh",
      expires_at: 1
    })}\n`;
    const previousSharedHome = process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME;
    process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME = sharedHome;
    try {
      const tooDeep = `${"[".repeat(34)}null${"]".repeat(34)}`;
      const invalidCredentials: Array<{ label: string; bytes: Buffer; expected: RegExp }> = [
        {
          label: "duplicate key",
          bytes: Buffer.from('{"refresh_token":"first","refresh_token":"second","expires_at":1}'),
          expected: /duplicate/iu
        },
        { label: "invalid UTF-8", bytes: Buffer.from([0x7b, 0xff, 0x7d]), expected: /UTF-8/iu },
        {
          label: "oversize",
          bytes: Buffer.alloc(1024 * 1024 + 1, 0x20),
          expected: /1048576-byte limit/iu
        },
        {
          label: "excessive depth",
          bytes: Buffer.from(`{"refresh_token":"source-refresh","future":${tooDeep}}`),
          expected: /nesting-depth limit of 32/iu
        }
      ];
      for (const [index, fixture] of invalidCredentials.entries()) {
        if (index === 0) fs.rmSync(sharedCredential, { force: true });
        else fs.writeFileSync(sharedCredential, validTarget, "utf8");
        fs.writeFileSync(sourceCredential, fixture.bytes);
        await assert.rejects(
          async () => {
            const command = await new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig)).buildCommand({
              prompt: fixture.label,
              cwd: project,
              options: {}
            });
            await command.cleanup?.();
          },
          fixture.expected,
          fixture.label
        );
      }

      const outsideCredential = path.join(project, "outside-kimi-credential.json");
      fs.writeFileSync(outsideCredential, validTarget, "utf8");
      fs.rmSync(sourceCredential, { force: true });
      fs.symlinkSync(outsideCredential, sourceCredential);
      fs.rmSync(sharedCredential, { force: true });
      await assert.rejects(async () => {
        const command = await new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig)).buildCommand({
          prompt: "Symlinked source credential",
          cwd: project,
          options: {}
        });
        await command.cleanup?.();
      }, /cannot open regular file|symbolic links|ELOOP/iu);
      fs.rmSync(sourceCredential);

      fs.writeFileSync(sourceCredential, validTarget, "utf8");
      fs.symlinkSync(path.join(project, "missing-target-credential.json"), sharedCredential);
      await assert.rejects(async () => {
        const command = await new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig)).buildCommand({
          prompt: "Dangling target credential",
          cwd: project,
          options: {}
        });
        await command.cleanup?.();
      }, /cannot open regular file|symbolic links|ELOOP/iu);
      fs.rmSync(sharedCredential);

      fs.writeFileSync(
        sourceCredential,
        `${JSON.stringify({
          access_token: "source-access",
          refresh_token: " target-refresh ",
          expires_at: 10_000
        })}\n`,
        "utf8"
      );
      fs.writeFileSync(sharedCredential, validTarget, "utf8");
      const exactTokenCommand = await new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig)).buildCommand({
        prompt: "Exact refresh token",
        cwd: project,
        options: {}
      });
      assert.equal(
        (JSON.parse(fs.readFileSync(sharedCredential, "utf8")) as { refresh_token?: string }).refresh_token,
        "target-refresh",
        "whitespace in a refresh token must remain data rather than being normalized into an identity match"
      );
      await exactTokenCommand.cleanup?.();
    } finally {
      if (previousSharedHome === undefined) delete process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME;
      else process.env.ULTRAFUZZ_KIMI_SHARED_AUTH_HOME = previousSharedHome;
    }

    const hintAgent = new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig));
    const hintInterpreter = hintAgent.createOutputInterpreter();
    const session = "00000000-0000-0000-0000-000000000301";
    assert.throws(
      () =>
        hintInterpreter.onStdoutLine?.(
          `{"type":"session.resume_hint","type":"session.resume_hint","session_id":${JSON.stringify(session)}}`
        ),
      /duplicate/iu
    );
    assert.throws(
      () => hintInterpreter.onStdoutLine?.(JSON.stringify({ type: "session.resume_hint", session_id: ` ${session}` })),
      /session_id is invalid/iu
    );
    assert.throws(
      () =>
        hintInterpreter.onStdoutLine?.(
          " ".repeat(1024 * 1024) + JSON.stringify({ type: "session.resume_hint", session_id: session })
        ),
      /1048576-byte limit/iu
    );
    assert.throws(() => hintInterpreter.onStdoutLine?.('{"provider_status":'), /Kimi output JSON is invalid/iu);
    assert.doesNotThrow(() => hintInterpreter.onStdoutLine?.("Kimi Code provider banner"));
  }
);

test(
  "generated Kimi adapter strictly parses session indexes and state snapshots",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-strict-session-state");
    const session = "00000000-0000-0000-0000-000000000302";
    const bucket = "wd_target_000000000302";
    const sessionDir = path.join(sourceConfig, "sessions", bucket, session);
    const indexPath = path.join(sourceConfig, "session_index.jsonl");
    const statePath = path.join(sessionDir, "state.json");
    fs.mkdirSync(sessionDir, { recursive: true });
    const validIndex = `${JSON.stringify({ sessionId: session, sessionDir, workDir: project })}\n`;
    const tooDeep = `${"[".repeat(34)}null${"]".repeat(34)}`;

    const brokenAbandonedHome = path.join(sourceConfig, ".ultrafuzz-invocations", "home-broken");
    fs.mkdirSync(path.join(brokenAbandonedHome, "session_index.jsonl"), { recursive: true });
    await assert.rejects(async () => {
      const command = await new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig)).buildCommand({
        prompt: "Present unreadable abandoned index",
        cwd: project,
        options: { resumeSession: session }
      });
      await command.cleanup?.();
    }, /not a regular file/iu);
    fs.rmSync(brokenAbandonedHome, { recursive: true, force: true });

    const invalidIndexes: Array<{ label: string; bytes: Buffer; expected: RegExp }> = [
      {
        label: "duplicate key",
        bytes: Buffer.from(
          `{"sessionId":${JSON.stringify(session)},"sessionId":${JSON.stringify(
            session
          )},"sessionDir":${JSON.stringify(sessionDir)},"workDir":${JSON.stringify(project)}}\n`
        ),
        expected: /duplicate/iu
      },
      { label: "invalid UTF-8", bytes: Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), expected: /UTF-8/iu },
      {
        label: "oversize record",
        bytes: Buffer.from(
          `${JSON.stringify({
            sessionId: session,
            sessionDir,
            workDir: project,
            padding: "x".repeat(1024 * 1024)
          })}\n`
        ),
        expected: /record 1 exceeds the 1048576-byte limit/iu
      },
      {
        label: "excessive depth",
        bytes: Buffer.from(
          `{"sessionId":${JSON.stringify(session)},"sessionDir":${JSON.stringify(
            sessionDir
          )},"workDir":${JSON.stringify(project)},"future":${tooDeep}}\n`
        ),
        expected: /nesting-depth limit of 32/iu
      },
      { label: "torn final record", bytes: Buffer.from(validIndex.trimEnd()), expected: /torn or unterminated/iu }
    ];
    for (const fixture of invalidIndexes) {
      fs.writeFileSync(indexPath, fixture.bytes);
      await assert.rejects(
        async () => {
          const command = await new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig)).buildCommand({
            prompt: fixture.label,
            cwd: project,
            options: { resumeSession: session }
          });
          await command.cleanup?.();
        },
        fixture.expected,
        fixture.label
      );
    }

    fs.writeFileSync(indexPath, validIndex, "utf8");
    const invalidStates: Array<{ label: string; bytes: Buffer; expected: RegExp }> = [
      {
        label: "duplicate key",
        bytes: Buffer.from('{"agents":{},"agents":{}}'),
        expected: /duplicate/iu
      },
      { label: "invalid UTF-8", bytes: Buffer.from([0x7b, 0xff, 0x7d]), expected: /UTF-8/iu },
      {
        label: "oversize",
        bytes: Buffer.alloc(1024 * 1024 + 1, 0x20),
        expected: /1048576-byte limit/iu
      },
      {
        label: "excessive depth",
        bytes: Buffer.from(`{"agents":{},"future":${tooDeep}}`),
        expected: /nesting-depth limit of 32/iu
      }
    ];
    for (const fixture of invalidStates) {
      fs.writeFileSync(statePath, fixture.bytes);
      await assert.rejects(
        async () => {
          const command = await new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig)).buildCommand({
            prompt: fixture.label,
            cwd: project,
            options: { resumeSession: session }
          });
          await command.cleanup?.();
        },
        fixture.expected,
        fixture.label
      );
    }
  }
);

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
  "generated Kimi adapter rejects malformed wire records instead of fabricating tokens",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-usage-malformed");
    const options = kimiSubscriptionOptions(sourceConfig);

    const malformed = new KimiCode029Agent(options);
    const malformedCommand = await malformed.buildCommand({
      prompt: "Malformed usage",
      cwd: "/workspace/target",
      options: {}
    });
    const malformedHome = malformedCommand.env?.KIMI_CODE_HOME;
    assert.ok(malformedHome);
    writeKimiWire(malformedHome, "wd_target_000000000203/session-203", "main", [
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
    assert.throws(
      () => malformed.createOutputInterpreter().onExit?.(kimiExitResult(malformedCommand.args)),
      /invalid strict JSON/iu
    );
    await malformedCommand.cleanup?.();

    const absent = new KimiCode029Agent(options);
    const absentCommand = await absent.buildCommand({ prompt: "No usage", cwd: "/workspace/target", options: {} });
    const absentHome = absentCommand.env?.KIMI_CODE_HOME;
    assert.ok(absentHome);
    writeKimiWire(absentHome, "wd_target_000000000204/session-204", "main", [
      kimiWireHeaderLine("session-204"),
      "still not json",
      JSON.stringify({ type: "usage.record", usage: { inputOther: Number.NaN } })
    ]);
    assert.throws(
      () => absent.createOutputInterpreter().onExit?.(kimiExitResult(absentCommand.args)),
      /invalid strict JSON/iu
    );
    await absentCommand.cleanup?.();
  }
);

test(
  "generated Kimi adapter rejects ambiguous, invalidly encoded, oversized, or deep wire JSON",
  { skip: !runningUnderBun },
  async () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const { KimiCode029Agent } = await loadGeneratedKimiAgent(project);
    const sourceConfig = writeKimiSourceConfig(project, "kimi-wire-strict-json");
    const tooDeep = `${"[".repeat(34)}null${"]".repeat(34)}`;
    const invalidWires: Array<{ label: string; bytes: Buffer; expected: RegExp }> = [
      {
        label: "duplicate key",
        bytes: Buffer.from(
          '{"type":"usage.record","type":"usage.record","usage":{"inputOther":1,"output":2,"inputCacheRead":3,"inputCacheCreation":4}}\n'
        ),
        expected: /duplicate/iu
      },
      { label: "invalid UTF-8", bytes: Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), expected: /UTF-8/iu },
      {
        label: "oversize line",
        bytes: Buffer.from(`${JSON.stringify({ type: "message.appended", padding: "x".repeat(1024 * 1024) })}\n`),
        expected: /line exceeded its byte budget/iu
      },
      {
        label: "excessive depth",
        bytes: Buffer.from(`{"type":"message.appended","future":${tooDeep}}\n`),
        expected: /nesting-depth limit of 32/iu
      },
      {
        label: "torn final record",
        bytes: Buffer.from('{"type":"message.appended"'),
        expected: /torn or unterminated/iu
      }
    ];
    for (const [index, fixture] of invalidWires.entries()) {
      const agent = new KimiCode029Agent(kimiSubscriptionOptions(sourceConfig));
      const command = await agent.buildCommand({ prompt: fixture.label, cwd: project, options: {} });
      const home = command.env?.KIMI_CODE_HOME;
      assert.ok(home);
      const wire = path.join(home, "sessions", `bucket-${index}`, "session-303", "agents", "main", "wire.jsonl");
      fs.mkdirSync(path.dirname(wire), { recursive: true });
      fs.writeFileSync(wire, fixture.bytes);
      assert.throws(
        () => agent.createOutputInterpreter().onExit?.(kimiExitResult(command.args)),
        fixture.expected,
        fixture.label
      );
      await command.cleanup?.();
    }
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
    assert.throws(
      () => oversized.createOutputInterpreter().onExit?.(kimiExitResult(oversizedCommand.args)),
      /torn or unterminated|line exceeded/iu
    );
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
    assert.throws(
      () => overflowing.createOutputInterpreter().onExit?.(kimiExitResult(overflowingCommand.args)),
      /safe integer range/iu
    );
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
    assert.throws(
      () => tooMany.createOutputInterpreter().onExit?.(kimiExitResult(tooManyCommand.args)),
      /file budget/iu
    );
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
    assert.throws(
      () => replaced.createOutputInterpreter().onExit?.(kimiExitResult(replacedCommand.args)),
      /replaced or truncated/iu
    );
    await replacedCommand.cleanup?.();
  }
);

test(
  "generated Kimi completed-event usage is what pinned Smithers 0.34.0 consumes",
  { skip: !runningUnderBun },
  async () => {
    const smithersEntry = fs.realpathSync(path.join(process.cwd(), "node_modules", "smthrs", "src", "index.js"));
    const resolved = createRequire(smithersEntry).resolve("@smthrs/agents/BaseCliAgent");
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

test("validate requires agentFactories entries for every configured model profile", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  writeSmallTopology(project);
  fs.writeFileSync(
    path.join(project, ".smithers/agents/index.ts"),
    'export { createCodexAgent } from "./codex";\n' +
      'export { ClaudeAgent } from "./claude";\n' +
      "export const agentFactories = {\n" +
      "  CodexAgent: createCodexAgent,\n" +
      "  // DeepSeekAgent: createDeepSeekAgent,\n" +
      '  note: "KimiAgent:"\n' +
      "};\n",
    "utf8"
  );

  const validate = await validateProject({ projectRoot: project, env: {} });
  assert.equal(validate.ok, false);
  const unknownAgents = validate.diagnostics
    .filter((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN")
    .map((diagnostic) => diagnostic.message);
  assert.equal(unknownAgents.length, 4, JSON.stringify(validate.diagnostics));
  assert.match(unknownAgents.join("\n"), /ClaudeAgent/u);
  assert.match(unknownAgents.join("\n"), /DeepSeekAgent/u);
  assert.match(unknownAgents.join("\n"), /KimiAgent/u);
  assert.match(unknownAgents.join("\n"), /OpenRouterAgent/u);

  const kimiRun = await startRun({
    projectRoot: project,
    runId: "missing-kimi-agent",
    agent: "KimiAgent",
    env: fakeSmithersEnv(project)
  });
  assert.equal(kimiRun.ok, false);
  assert.ok(kimiRun.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN"));
});

test("validate requires every configured agent factory after a default agent override", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  writeSmallTopology(project);
  const registryPath = path.join(project, ".smithers/agents/index.ts");
  fs.writeFileSync(
    registryPath,
    fs.readFileSync(registryPath, "utf8").replace("  CodexAgent: createCodexAgent,\n", ""),
    "utf8"
  );

  const validate = await validateProject({ projectRoot: project, agent: "ClaudeAgent", env: {} });

  assert.equal(validate.ok, false);
  assert.deepEqual(
    validate.diagnostics
      .filter((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN")
      .map((diagnostic) => diagnostic.message.match(/agent reference (\w+)/u)?.[1]),
    ["CodexAgent"]
  );
});

test("validate accepts a typed aliased registry composed from static spreads", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  writeSmallTopology(project);
  fs.writeFileSync(
    path.join(project, ".smithers/agents/index.ts"),
    "type Factory = () => unknown;\n" +
      "const ClaudeAgent: Factory = () => null;\n" +
      "const CodexAgent: Factory = () => null;\n" +
      "const createAgent: Factory = () => null;\n" +
      "const core = Object.freeze({\n" +
      "  ClaudeAgent,\n" +
      '  ["CodexAgent"]: CodexAgent\n' +
      "} as const);\n" +
      "const optIn = {\n" +
      '  "DeepSeekAgent": createAgent,\n' +
      "  KimiAgent: createAgent,\n" +
      "  OpenRouterAgent: createAgent\n" +
      "};\n" +
      "const registry: Record<string, Factory> = { ...core, ...optIn };\n" +
      "export { registry as agentFactories };\n",
    "utf8"
  );

  const validate = await validateProject({ projectRoot: project, env: {} });
  const preserved = initProject({ projectRoot: project });

  assert.equal(validate.ok, true, JSON.stringify(validate.diagnostics));
  assert.equal(preserved.ok, true, JSON.stringify(preserved.diagnostics));
  assert.equal(
    preserved.diagnostics.some((diagnostic) => diagnostic.code === "INIT_AGENT_REGISTRY_STALE"),
    false
  );
});

test("validate applies registry overwrite order and rejects nullish or shadowed factories", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  writeSmallTopology(project);
  const registryPath = path.join(project, ".smithers/agents/index.ts");
  const factories =
    "const factory = () => ({ id: 'agent' });\n" +
    "const core = { ClaudeAgent: factory, CodexAgent: factory, DeepSeekAgent: factory, KimiAgent: factory, OpenRouterAgent: factory };\n";

  fs.writeFileSync(
    registryPath,
    factories + "const registry = { ...core, CodexAgent: undefined };\nexport { registry as agentFactories };\n",
    "utf8"
  );
  const overwritten = await validateProject({ projectRoot: project, env: {} });
  assert.equal(overwritten.ok, false);
  assert.equal(
    overwritten.diagnostics.filter(
      (diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN" && /CodexAgent/u.test(diagnostic.message)
    ).length,
    1
  );

  fs.writeFileSync(
    registryPath,
    factories +
      "const unknown = dynamicRegistry();\nconst registry = { ...core, ...unknown };\nexport { registry as agentFactories };\n",
    "utf8"
  );
  const unknownOverride = await validateProject({ projectRoot: project, env: {} });
  assert.equal(unknownOverride.ok, false);
  assert.equal(
    unknownOverride.diagnostics.filter((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN").length,
    5
  );

  fs.writeFileSync(
    registryPath,
    "const Object = { freeze: (value: unknown) => value };\n" +
      factories +
      "export const agentFactories = Object.freeze(core);\n",
    "utf8"
  );
  const shadowed = await validateProject({ projectRoot: project, env: {} });
  assert.equal(shadowed.ok, false);
  assert.ok(shadowed.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_REGISTRY_INVALID"));

  fs.writeFileSync(
    registryPath,
    "const { Object } = customGlobals;\n" + factories + "export const agentFactories = Object.freeze(core);\n",
    "utf8"
  );
  const destructuredShadow = await validateProject({ projectRoot: project, env: {} });
  assert.equal(destructuredShadow.ok, false);
  assert.ok(destructuredShadow.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_REGISTRY_INVALID"));
});

test("validate rejects unsafe or oversized canonical agent registries with diagnostics", async () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  writeSmallTopology(project);
  const registryPath = path.join(project, ".smithers/agents/index.ts");
  const outside = path.join(project, "outside-registry.ts");
  fs.writeFileSync(outside, fs.readFileSync(registryPath));
  fs.unlinkSync(registryPath);
  fs.linkSync(outside, registryPath);
  const hardlinked = await validateProject({ projectRoot: project, env: {} });
  assert.equal(hardlinked.ok, false);
  assert.ok(hardlinked.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_REGISTRY_INVALID"));

  fs.unlinkSync(registryPath);
  fs.writeFileSync(registryPath, `export const agentFactories = {};/*${"x".repeat(256 * 1024)}*/`, "utf8");
  const oversized = await validateProject({ projectRoot: project, env: {} });
  assert.equal(oversized.ok, false);
  assert.ok(oversized.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_REGISTRY_INVALID"));
});

test("validate ignores textual, type-only, and cyclic agentFactories lookalikes", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  writeSmallTopology(project);
  fs.writeFileSync(
    path.join(project, ".smithers/agents/index.ts"),
    'export const decoy = "export const agentFactories = { ClaudeAgent: fake, CodexAgent: fake, DeepSeekAgent: fake, KimiAgent: fake, OpenRouterAgent: fake }";\n' +
      "const first = { ...second };\n" +
      "const second = { ...first };\n" +
      "export type { first as agentFactories };\n",
    "utf8"
  );

  const validate = await validateProject({ projectRoot: project, env: {} });

  assert.equal(validate.ok, false);
  assert.deepEqual(
    validate.diagnostics
      .filter((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN")
      .map((diagnostic) => diagnostic.message.match(/agent reference (\w+)/u)?.[1]),
    ["ClaudeAgent", "CodexAgent", "DeepSeekAgent", "KimiAgent", "OpenRouterAgent"]
  );

  fs.writeFileSync(
    path.join(project, ".smithers/agents/index.ts"),
    "const first = { ...second };\n" + "const second = { ...first };\n" + "export { first as agentFactories };\n",
    "utf8"
  );
  const cyclic = await validateProject({ projectRoot: project, env: {} });
  assert.equal(cyclic.ok, false);
  assert.equal(
    cyclic.diagnostics.filter((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN").length,
    5,
    JSON.stringify(cyclic.diagnostics)
  );

  fs.writeFileSync(
    path.join(project, ".smithers/agents/index.ts"),
    "const registry = { ClaudeAgent: factory, CodexAgent: factory, DeepSeekAgent: factory, KimiAgent: factory, OpenRouterAgent: factory };\n" +
      "export { type registry as agentFactories };\n",
    "utf8"
  );
  const typeSpecifier = await validateProject({ projectRoot: project, env: {} });
  assert.equal(typeSpecifier.ok, false);
  assert.equal(
    typeSpecifier.diagnostics.filter((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN").length,
    5,
    JSON.stringify(typeSpecifier.diagnostics)
  );
});

test("validate accepts quoted factory keys for current custom agent IDs", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs.readFileSync(configPath, "utf8").replace('agent = "CodexAgent"', 'agent = "custom.agent:v1-beta"'),
    "utf8"
  );
  const registryPath = path.join(project, ".smithers/agents/index.ts");
  fs.writeFileSync(
    registryPath,
    fs
      .readFileSync(registryPath, "utf8")
      .replace(
        "  OpenRouterAgent: createOpenRouterAgent\n",
        '  OpenRouterAgent: createOpenRouterAgent,\n  "custom.agent:v1-beta": createCodexAgent\n'
      ),
    "utf8"
  );

  const validate = await validateProject({ projectRoot: project, env: {} });

  assert.equal(validate.ok, true, JSON.stringify(validate.diagnostics));
});

test("validate does not fall back to .smithers/agents.ts", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  writeSmallTopology(project);
  fs.renameSync(path.join(project, ".smithers/agents/index.ts"), path.join(project, ".smithers/agents.ts"));

  const validate = await validateProject({ projectRoot: project, env: {} });

  assert.equal(validate.ok, false);
  assert.ok(validate.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_REGISTRY_MISSING"));
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
  assert.match(renderedPrompt, /Contract: `ultrafuzz\/findings@2`/u);
  assert.match(
    renderedPrompt,
    /Purpose: Canonical structured findings with source-bound evidence and independent explanatory analysis\./u
  );
  assert.match(renderedPrompt, /Validation command: `ultrafuzz json validate --schema/u);
  assert.match(renderedPrompt, /After your final write and before returning the node's final response/u);
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

test("plan renders the standard findings variable from the exact typed output declaration", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const topologyPath = path.join(project, ".ultrafuzz", "topology.yml");
  fs.writeFileSync(
    topologyPath,
    fs.readFileSync(topologyPath, "utf8").replace("- path: findings.json", "- path: custom/review-findings.json"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md"),
    `---
id: project-discovery
display_name: Project Discovery
---

Write findings to {{output_findings_path}}.
{{finding_reachability_vocabulary}}
{{finding_note_key_vocabulary}}
`,
    "utf8"
  );

  const plan = await planRun({ projectRoot: project, runId: "declared-findings-path", env: {} });

  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const renderedPrompt = fs.readFileSync(plan.value!.rendered_prompts[0]!.rendered_prompt_path, "utf8");
  const expectedPath = path.join(
    plan.value!.run_root,
    "artifacts",
    "project-discovery",
    "custom",
    "review-findings.json"
  );
  assert.ok(renderedPrompt.includes(`findings to ${expectedPath}.`), renderedPrompt);
  assert.ok(renderedPrompt.includes(`--file '${expectedPath}'`), renderedPrompt);
  assert.doesNotMatch(renderedPrompt, /artifacts\/project-discovery\/findings\.json/u);
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
{{finding_reachability_vocabulary}}
{{finding_note_key_vocabulary}}
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
        contract: ultrafuzz/findings@2
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
      "json-validation-correction",
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
  assert.equal(executable.length, 8);
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
    const artifactManifest = JSON.parse(
      fs.readFileSync(
        path.join(plan.value!.run_root, "artifacts", "reference-properties-example", "artifact-manifest.json"),
        "utf8"
      )
    ) as { schema_version?: string; provenance?: { metadata?: unknown } };
    assert.equal(artifactManifest.schema_version, "ultrafuzz.artifact-manifest.v3");
    assert.deepEqual(artifactManifest.provenance?.metadata, {
      reference: "properties.example",
      repo: "example/repo",
      commit: "a".repeat(40),
      reference_artifact: referenceArtifact,
      manifest_artifact: referenceManifest
    });
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
      schema_version: "ultrafuzz.reference-expectations.v2",
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
          output.path === "references/expectations.json" && output.contract === "ultrafuzz/reference-expectations@2"
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
      schema_version: "ultrafuzz.reference-expectations.v2",
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

test("plan rejects duplicate-key expectation bytes before any schema or handoff processing", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeReferenceTopology(project);
  const sourcePath = path.join(project, "reference-expectations.json");
  fs.writeFileSync(
    sourcePath,
    '{"schema_version":"ultrafuzz.reference-expectations.v2","expectations":[],"expectations":[]}\n',
    "utf8"
  );
  const before = fs.readFileSync(sourcePath);
  const xdgCacheHome = path.join(project, "xdg-cache");
  writeReferenceCache(xdgCacheHome);
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = xdgCacheHome;
  try {
    const plan = await planRun({
      projectRoot: project,
      runId: "duplicate-reference-expectations",
      referenceExpectationsPath: "reference-expectations.json",
      env: {}
    });

    assert.equal(plan.ok, false);
    assert.match(plan.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /duplicate property name/u);
    assert.deepEqual(fs.readFileSync(sourcePath), before);
  } finally {
    if (previousXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = previousXdgCacheHome;
    }
  }
});

test("plan rejects duplicate reference expectation IDs before publishing trusted handoffs", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeReferenceTopology(project);
  const sourcePath = path.join(project, "reference-expectations.json");
  fs.writeFileSync(
    sourcePath,
    JSON.stringify({
      schema_version: "ultrafuzz.reference-expectations.v2",
      expectations: [
        { id: "benchmark:duplicate", description: "First spelling." },
        { id: "benchmark:duplicate", description: "Second spelling." }
      ]
    }),
    "utf8"
  );
  const before = fs.readFileSync(sourcePath);
  const xdgCacheHome = path.join(project, "xdg-cache");
  writeReferenceCache(xdgCacheHome);
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = xdgCacheHome;
  try {
    const plan = await planRun({
      projectRoot: project,
      runId: "duplicate-reference-expectation-ids",
      referenceExpectationsPath: "reference-expectations.json",
      env: {}
    });

    assert.equal(plan.ok, false, JSON.stringify(plan.diagnostics));
    assert.ok(plan.diagnostics.some((diagnostic) => diagnostic.code === "REFERENCE_EXPECTATIONS_INVALID"));
    assert.match(
      plan.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
      /Duplicate reference expectation ID/u
    );
    assert.deepEqual(fs.readFileSync(sourcePath), before);
    assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "runs", "duplicate-reference-expectation-ids")), false);
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

  const resolvedConfigBytes = fs.readFileSync(compiled.resolvedConfigPath);
  assert.deepEqual(resolvedConfigBytes, serializeResolvedConfigJsonBytes(plan.value!.resolved_config));
  assert.equal(parseResolvedConfigJsonBytes(resolvedConfigBytes).schemaVersion, "ultrafuzz.resolved-config.v3");

  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  assert.equal(compiled.pinnedSubmodules, undefined);
  assert.match(workflowSource, /"pinnedSubmodules": null/u);
  assert.match(workflowSource, /dependsOn=\{task\.dependsOn\}/);
  assert.match(workflowSource, /const taskOutput = z\.strictObject\(\{/);
  assert.match(workflowSource, /summary: z\.string\(\)\.min\(1\)/);
  assert.match(workflowSource, /smithers-display-name: Ultrafuzz native-deps/);
  assert.doesNotMatch(workflowSource, /__ULTRAFUZZ_/);
  assert.doesNotMatch(workflowSource, /const layers =/);
  assert.doesNotMatch(workflowSource, /<Sequence\b/);
  assert.match(workflowSource, /<Parallel\b/);
  assert.doesNotMatch(workflowSource, /agentRegistry/u);
  assert.match(workflowSource, /agent factory is not registered/u);
  assert.match(workflowSource, /agent factory returned no agents/u);
  assert.match(workflowSource, /agent factory returned a nullish agent chain entry/u);

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
  assert.equal(discovery.retries, 0);
  assert.deepEqual(discovery.execution.resources, {
    cpu: 8,
    memoryMiB: 16384,
    timeoutSeconds: 1800
  });
  assert.deepEqual(discovery.execution.agentCredentialEnv, ["OPENAI_API_KEY"]);
  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  assert.match(workflowSource, /<Sandbox/);
  assert.match(workflowSource, /<Sandbox[\s\S]*?retries=\{0\}/u);
  assert.match(
    workflowSource,
    /<Task[\s\S]*?agent=\{agentForTask\(task, fullTaskPrompt\)\}[\s\S]*?retries=\{task\.retries\}/u
  );
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

test("compileSmithersWorkflow exhausts same-profile retries before ordered fallback", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace("same_agent_attempts = 1", 'same_agent_attempts = 3\nagents = ["sol-xhigh", "gpt55-xhigh"]')
      .replace(
        "[models.claude]",
        '[models.sol-xhigh]\nagent = "CodexAgent"\nmodel = "gpt-5.6-sol"\nreasoning = "xhigh"\n\n' +
          '[models.gpt55-xhigh]\nagent = "CodexAgent"\nmodel = "gpt-5.5"\nreasoning = "xhigh"\n\n' +
          "[models.claude]"
      ),
    "utf8"
  );

  const plan = await planRun({ projectRoot: project, runId: "ordered-retry-chain", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-ordered-retry-chain",
    renderedPrompts: plan.value!.rendered_prompts
  });

  const task = compiled.tasks.find((candidate) => candidate.logicalNodeId === "project-discovery");
  assert.ok(task);
  assert.deepEqual(
    task.agentChain.map((entry) => [entry.profileId, entry.modelName, entry.reasoningEffort, entry.role]),
    [
      ["sol-xhigh", "gpt-5.6-sol", "xhigh", "primary"],
      ["sol-xhigh", "gpt-5.6-sol", "xhigh", "primary"],
      ["sol-xhigh", "gpt-5.6-sol", "xhigh", "primary"],
      ["gpt55-xhigh", "gpt-5.5", "xhigh", "fallback"]
    ]
  );
  assert.equal(task.retries, 3);
  assert.deepEqual(task.retryPolicy, { backoff: "exponential", initialDelayMs: 1_000 });
  assert.deepEqual(task.metadata.retryPolicy, {
    maxAttempts: 4,
    sameAgentAttempts: 3,
    smithersRetries: 3
  });
  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  assert.match(workflowSource, /agent=\{agentForTask\(task, fullTaskPrompt\)\}/u);
  assert.doesNotMatch(workflowSource, /maxDelayMs/u);
});

test("compileSmithersWorkflow enforces the 100-rung retry cap before expanding topology overrides", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace("same_agent_attempts = 1", 'same_agent_attempts = 99\nagents = ["primary", "fallback"]')
      .replace(
        "[models.claude]",
        '[models.primary]\nagent = "CodexAgent"\nmodel = "gpt-5.5"\nreasoning = "xhigh"\n\n' +
          '[models.fallback]\nagent = "CodexAgent"\nmodel = "gpt-5.6-sol"\nreasoning = "xhigh"\n\n' +
          "[models.claude]"
      ),
    "utf8"
  );
  const plan = await planRun({ projectRoot: project, runId: "retry-chain-limit", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compile = () =>
    compileSmithersWorkflow({
      projectRoot: project,
      config: plan.value!.resolved_config,
      graph: plan.value!.expanded_graph,
      runLayout: plan.value!.layout,
      workflowName: "ultrafuzz-retry-chain-limit",
      renderedPrompts: plan.value!.rendered_prompts
    });

  const boundary = compile();
  assert.equal(boundary.tasks.find((task) => task.logicalNodeId === "project-discovery")?.agentChain.length, 100);

  const discovery = plan.value!.expanded_graph.nodes.find((node) => node.logicalId === "project-discovery");
  assert.ok(discovery);
  discovery.retryPolicy.maxAttempts = 100;
  assert.throws(compile, /retry chain expands to 101 attempts; maximum is 100/u);
});

test("planRun rejects an oversized topology retry override before creating the run directory", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace("same_agent_attempts = 1", 'same_agent_attempts = 1\nagents = ["primary", "fallback"]')
      .replace(
        "[models.claude]",
        '[models.primary]\nagent = "CodexAgent"\nmodel = "gpt-5.5"\nreasoning = "xhigh"\n\n' +
          '[models.fallback]\nagent = "CodexAgent"\nmodel = "gpt-5.6-sol"\nreasoning = "xhigh"\n\n' +
          "[models.claude]"
      ),
    "utf8"
  );
  const topologyPath = path.join(project, ".ultrafuzz", "topology.yml");
  fs.writeFileSync(
    topologyPath,
    fs
      .readFileSync(topologyPath, "utf8")
      .replace(
        "    prompt: setup/project-discovery.md",
        "    prompt: setup/project-discovery.md\n    max_attempts: 100"
      ),
    "utf8"
  );

  const runId = "retry-chain-preflight-limit";
  const result = await planRun({ projectRoot: project, runId, topologyPath: ".ultrafuzz/topology.yml", env: {} });
  assert.equal(result.ok, false, JSON.stringify(result.value?.expanded_graph.nodes));
  assert.match(JSON.stringify(result.diagnostics), /retry chain expands to 101 attempts; maximum is 100/u);
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "runs", runId)), false);
});

test("planRun rejects cloud retry chains before creating the run directory", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  const config = fs
    .readFileSync(configPath, "utf8")
    .replace('[execution]\nmode = "local"', '[execution]\nmode = "cloud"\nprovider = "modal"')
    .replace("same_agent_attempts = 1", "same_agent_attempts = 2");
  fs.writeFileSync(
    configPath,
    `${config}\n[execution.providers.modal]\napp = "ultrafuzz-test"\nimage = "ultrafuzz-test"\ncredential_env = ["UFZ_PROVIDER_ONE", "UFZ_PROVIDER_TWO"]\n`,
    "utf8"
  );

  const runId = "cloud-retry-chain-rejected";
  const result = await planRun({
    projectRoot: project,
    runId,
    env: { UFZ_PROVIDER_ONE: "provider-one", UFZ_PROVIDER_TWO: "provider-two", OPENAI_API_KEY: "agent-key" }
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0]?.message ?? "", /cloud execution currently requires one model attempt/u);
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "runs", runId)), false);
});

test("runtime model overrides apply to the retry policy's configured primary profile", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace("same_agent_attempts = 1", 'same_agent_attempts = 2\nagents = ["sol-xhigh", "gpt55-xhigh"]')
      .replace(
        "[models.claude]",
        '[models.sol-xhigh]\nagent = "CodexAgent"\nmodel = "gpt-5.6-sol"\nreasoning = "xhigh"\n\n' +
          '[models.gpt55-xhigh]\nagent = "CodexAgent"\nmodel = "gpt-5.5"\nreasoning = "xhigh"\n\n' +
          "[models.claude]"
      ),
    "utf8"
  );

  const plan = await planRun({
    projectRoot: project,
    runId: "retry-primary-runtime-override",
    model: "gpt-5.6-sol-override",
    reasoning: "high",
    env: {}
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.value!.resolved_config.models.profiles["sol-xhigh"]?.model, "gpt-5.6-sol-override");
  assert.equal(plan.value!.resolved_config.models.profiles["sol-xhigh"]?.reasoning, "high");
  assert.equal(plan.value!.resolved_config.models.profiles["gpt55-xhigh"]?.model, "gpt-5.5");
  assert.ok(
    plan
      .value!.expanded_graph.nodes.flatMap((node) => node.modelFanout)
      .every(
        (selection) =>
          selection.modelProfileId !== "sol-xhigh" ||
          (selection.modelName === "gpt-5.6-sol-override" && selection.reasoningEffort === "high")
      )
  );
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

test("invariant campaign budget admits the shipped 7200-second node timeout", async () => {
  const compiled = await compileInvariantCampaignBudgetFixture({
    logicalNodeId: "stateful-invariant-campaign",
    nodeTimeoutSeconds: 7200,
    smokeTimeoutSeconds: 600,
    fuzzerTimeoutSeconds: 3600,
    runId: "campaign-budget-default"
  });
  assert.equal(compiled.tasks[0]?.timeoutMs, 7_200_000);
  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  assert.match(
    workflowSource,
    /"campaignTimeoutExpectations": \{\s*"configuredFuzzerTimeoutSeconds": 3600,\s*"plannedTimeoutSeconds": 7200,\s*"finalizationReserveSeconds": 300\s*\}/u
  );
});

test("invariant campaign budget follows the @2 output contract on project-owned nodes", async () => {
  await assert.rejects(
    compileInvariantCampaignBudgetFixture({
      logicalNodeId: "project-owned-recon-campaign",
      nodeTimeoutSeconds: 7200,
      smokeTimeoutSeconds: 600,
      fuzzerTimeoutSeconds: 6001,
      runId: "campaign-budget-exceeded"
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /INVARIANT_CAMPAIGN_TIMEOUT_BUDGET_EXCEEDED/u);
      assert.match(error.message, /logical_node_id=project-owned-recon-campaign/u);
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
  // and OpenRouterAgent existed: the registry predates the adapters, and init
  // preserves project-owned files.
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
  assert.match(stale.map((entry) => entry.message).join("\n"), /OpenRouterAgent/);

  // A registry that names providers without registering their factories is
  // still stale: nothing resolves them, since generated adapters export only
  // factories.
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
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /OpenRouterAgent/);

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
    ultrafuzz_run_id?: string;
  };
  // `run_id` is the workflow runner's own reserved input column, so the run this
  // envelope is bound to must travel under a key the runner does not own.
  assert.equal(smithersInput.ultrafuzz_run_id, "smithers-run");
  assert.equal(Object.hasOwn(smithersInput, "run_id"), false);
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
  ) as {
    smithers_bin?: unknown;
    packages?: Array<{ id?: unknown; name?: unknown; snapshot_path?: unknown }>;
    issuers?: Array<{ id?: unknown; dependencies?: Record<string, unknown> }>;
  };
  assert.equal(
    localDependencyManifest.smithers_bin,
    null,
    "a pure-local workflow may keep using its explicit controller runner without sealing the pinned package"
  );
  assert.equal(
    localDependencyManifest.packages?.some((entry) => entry.name === "smthrs"),
    false,
    "the explicit controller runner must not be copied into the execution snapshot"
  );
  const sealedZod = localDependencyManifest.packages?.find((entry) => entry.name === "zod");
  assert.equal(typeof sealedZod?.id, "string", "module dependencies must retain zod with an external runner");
  assert.equal(typeof sealedZod?.snapshot_path, "string");
  assert.equal(
    localDependencyManifest.issuers?.find((issuer) => issuer.id === "module:@ultrafuzz/artifacts")?.dependencies?.zod,
    sealedZod?.id,
    "the artifacts module must resolve zod from the sealed dependency closure"
  );
  assert.equal(
    fs.statSync(path.join(localExecutionSnapshot, ...String(sealedZod?.snapshot_path).split("/"), "v4")).isDirectory(),
    true,
    "the sealed zod package must include its zod/v4 entrypoint"
  );

  const workflowSource = fs.readFileSync(
    path.join(project, ".smithers", "workflows", "ultrafuzz-smithers-run.tsx"),
    "utf8"
  );
  const expectedArtifactDir = path.join(run.value!.run_root, "artifacts", "project-discovery");
  assert.match(workflowSource, /smthrs/);
  assert.match(workflowSource, /const taskOutput = z\.strictObject\(/u);
  assert.match(workflowSource, /const preparationOutput = z\.strictObject\(/u);
  assert.match(workflowSource, /const verificationOutput = z\.strictObject\(/u);
  assert.doesNotMatch(workflowSource, /z\.object\(/u);
  // Explicit index path: a sibling .smithers/agents.ts scaffolded by Smithers
  // would otherwise shadow the .smithers/agents/ directory under bun.
  assert.match(workflowSource, /import \{ agentFactories as projectAgentFactories \} from "\.\.\/agents\/index\.ts";/);
  assert.doesNotMatch(workflowSource, /from "\.\.\/agents";/);
  assert.match(workflowSource, /agent=\{agentForTask\(task, fullTaskPrompt\)\}/);
  assert.match(workflowSource, /addDir:\s*\[task\.artifactDir, \.\.\.task\.dependencyArtifactDirs\]/);
  assert.match(workflowSource, /const schemaDirectory = path\.join\(workspaceRoot, "\.ultrafuzz", "schemas"\)/u);
  assert.match(workflowSource, /materializePromptSchemas\(schemaDirectory\)/u);
  assert.match(workflowSource, /relocatePromptPath\(prompt, task\.artifactDir, mirroredArtifactDir\(task\)\)/u);
  assert.match(workflowSource, /relocatePromptPath\(prompt, task\.sourceProjectRoot, process\.cwd\(\)\)/u);
  assert.match(workflowSource, /path\.join\(task\.workspacePath, "artifacts", task\.attemptId\)/);
  assert.match(workflowSource, /taskArtifactRoots\(task, artifactDir\)/);
  assert.match(workflowSource, /lstatSync\(candidate\)/);
  assert.match(workflowSource, /function isMissingPathError/);
  assert.match(workflowSource, /function prepareArtifactMirror/);
  assert.match(workflowSource, /function assertTaskInputs/);
  assert.match(workflowSource, /artifact handoff directory is unavailable/);
  assert.doesNotMatch(workflowSource, /canonicalEmptyArtifact|ultrafuzz\/findings@1/u);
  assert.match(workflowSource, /function artifactAwareAgent/);
  assert.match(workflowSource, /return await agent\.generate\(attemptArgs\)/u);
  assert.doesNotMatch(
    workflowSource,
    /materializeMissingMarkdownArtifacts|normalizeLegacyFinding|normalizeLegacyReportProvenance|normalizeLegacyGeneratedTest/u
  );
  assert.match(workflowSource, /function finalizeAndVerifyArtifacts/);
  assert.match(
    workflowSource,
    /function finalizeAndVerifyArtifacts[\s\S]*?prepareArtifactMirror\(task, \{[\s\S]*?pinnedSubmodules: "verify"/u
  );
  assert.doesNotMatch(
    workflowSource,
    /materializeGeneratedTestCompanion|const workspaceRelativePath = relativePath\.slice/
  );
  assert.match(workflowSource, /generatedTestNodeIds\(task\)/);
  assert.doesNotMatch(workflowSource, /typeof entry === "string" \? \{ path: entry \}/u);
  assert.doesNotMatch(
    workflowSource,
    /typeof finding\.confidence === "number"|finding\.confidence = String|finding\.strategy = legacyStrategy|finding\.evidence = \[evidence\]/u
  );
  assert.match(workflowSource, /verifyArtifacts\(task, capturedOutputs\);/);
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

test("listRuns requires the exact current Smithers ps envelope and row shape", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  const currentRow = {
    id: "workflow-current-1",
    workflow: "current-workflow",
    status: "running",
    dbStatus: "running",
    state: "running",
    step: "node:current",
    started: "1s"
  };
  const env = fakePsSmithersEnv(project, currentPsEnvelope([currentRow]));

  const current = await listRuns({ projectRoot: project, env });

  assert.equal(current.ok, true, JSON.stringify(current.diagnostics));
  assert.deepEqual(current.value?.runs, [
    {
      workflow_run_id: "workflow-current-1",
      workflow_status: "running",
      step: "node:current"
    }
  ]);

  const invalidOutputs: Array<{ label: string; value: unknown; message: RegExp }> = [
    {
      label: "unwrapped data",
      value: { runs: [currentRow] },
      message: /exact current full-output envelope/iu
    },
    {
      label: "malformed row mixed into the array",
      value: currentPsEnvelope([currentRow, null]),
      message: /runs\[1\].*exact current row shape/iu
    },
    {
      label: "runId alias",
      value: currentPsEnvelope([{ ...currentRow, id: undefined, runId: currentRow.id }]),
      message: /exact current row shape/iu
    },
    {
      label: "unknown state",
      value: currentPsEnvelope([{ ...currentRow, status: "unknown", state: "unknown" }]),
      message: /cannot be unknown/iu
    },
    {
      label: "status alias drift",
      value: currentPsEnvelope([{ ...currentRow, status: "failed" }]),
      message: /status does not match/iu
    },
    {
      label: "unknown row field",
      value: currentPsEnvelope([{ ...currentRow, run_id: currentRow.id }]),
      message: /exact current row shape/iu
    }
  ];
  for (const invalid of invalidOutputs) {
    fs.writeFileSync(env.SMITHERS_FAKE_PS!, `${JSON.stringify(invalid.value, null, 2)}\n`, "utf8");
    await assert.rejects(() => listRuns({ projectRoot: project, env }), invalid.message, invalid.label);
  }
});

test("getRunStatus uses only validated current runState and validates the events envelope", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "strict-state-export-inspection";
  const workflowRunId = `ultrafuzz-${runId}`;
  const launched = await startRun({ projectRoot: project, runId, env: fakeSmithersEnv(project) });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));
  const inspect = workflowInspect({
    workflowRunId,
    status: "failed",
    state: "running",
    steps: []
  });
  const env = fakeLifecycleSmithersEnv(project, { inspect });

  const current = await getRunStatus({ projectRoot: project, runId, env });

  assert.equal(current.ok, true, JSON.stringify(current.diagnostics));
  assert.equal(current.value?.workflow?.status, "running");

  const unknownState = structuredClone(inspect) as { data: { runState: { state: string } } };
  unknownState.data.runState.state = "unknown";
  fs.writeFileSync(env.SMITHERS_FAKE_INSPECT!, `${JSON.stringify(unknownState)}\n`, "utf8");
  await assert.rejects(() => getRunStatus({ projectRoot: project, runId, env }), /runState\.state is unknown/iu);

  const statusAlias = structuredClone(inspect) as { data: Record<string, unknown> };
  statusAlias.data.status = "running";
  fs.writeFileSync(env.SMITHERS_FAKE_INSPECT!, `${JSON.stringify(statusAlias)}\n`, "utf8");
  await assert.rejects(() => getRunStatus({ projectRoot: project, runId, env }), /removed field aliases/iu);

  fs.writeFileSync(env.SMITHERS_FAKE_INSPECT!, `${JSON.stringify(inspect)}\n`, "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_STATUS_EVENTS!, "[]\n", "utf8");
  await assert.rejects(
    () => getRunStatus({ projectRoot: project, runId, env }),
    /events output must use the exact current full-output envelope/iu
  );

  fs.writeFileSync(
    env.SMITHERS_FAKE_STATUS_EVENTS!,
    `${JSON.stringify({ ok: true, data: [{ malformed: true }], meta: { command: "events", duration: "1ms" } })}\n`,
    "utf8"
  );
  await assert.rejects(
    () => getRunStatus({ projectRoot: project, runId, env }),
    /events data\[0\].*non-empty string/iu
  );
});

test("getRunStatus counts only a canonical event-v2 journal and fails closed on invalid presence", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "strict-state-export-events";
  const workflowRunId = `ultrafuzz-${runId}`;
  const launched = await startRun({ projectRoot: project, runId, env: fakeSmithersEnv(project) });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));
  const layout = layoutForRunRoot(launched.value!.run_root, runId);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({ workflowRunId, status: "running", state: "running", steps: [] })
  });

  const current = await getRunStatus({ projectRoot: project, runId, env });

  assert.equal(current.ok, true, JSON.stringify(current.diagnostics));
  assert.equal(current.value?.events, replayEvents(layout, Number.MAX_SAFE_INTEGER).records.length);

  const record = createEventRecord(
    { runId },
    {
      eventType: "findings-validated",
      nodeId: "final-report",
      status: "succeeded",
      timestamp: "2026-08-09T00:00:00.000Z",
      payload: { count: 1, path: "artifacts/final-report/report.json" }
    }
  );
  const line = JSON.stringify(record);
  const invalidDocuments: Array<{ label: string; contents: string; message: RegExp }> = [
    { label: "malformed", contents: '{"schema_version":\n', message: /invalid strict JSON/iu },
    {
      label: "duplicate key",
      contents: `${line.replace(`"run_id":"${runId}"`, `"run_id":"${runId}","run_id":"${runId}"`)}\n`,
      message: /duplicate property name/iu
    },
    {
      label: "foreign run",
      contents: `${JSON.stringify({ ...record, run_id: "foreign-run" })}\n`,
      message: /belongs to.*expected/iu
    },
    { label: "duplicate identity", contents: `${line}\n${line}\n`, message: /duplicate identity/iu },
    { label: "torn tail", contents: line, message: /torn or unterminated/iu }
  ];
  for (const invalid of invalidDocuments) {
    fs.writeFileSync(layout.eventsPath, invalid.contents, "utf8");
    const before = fs.readFileSync(layout.eventsPath);
    await assert.rejects(() => getRunStatus({ projectRoot: project, runId, env }), invalid.message, invalid.label);
    assert.deepEqual(fs.readFileSync(layout.eventsPath), before, invalid.label);
  }

  fs.unlinkSync(layout.eventsPath);
  fs.symlinkSync(`${layout.eventsPath}.missing`, layout.eventsPath);
  await assert.rejects(() => getRunStatus({ projectRoot: project, runId, env }), /cannot open regular file|symlink/iu);
  fs.unlinkSync(layout.eventsPath);
  fs.mkdirSync(layout.eventsPath);
  await assert.rejects(() => getRunStatus({ projectRoot: project, runId, env }), /not a regular file/iu);
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
  // The runner emits the `{ok, data, meta}` envelope this reader requires only
  // under --full-output. Asking without it returned a bare document and made
  // `ultrafuzz status` fail against every real run.
  assert.match(
    fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"),
    /status ultrafuzz-health-run --window 5 --format json --full-output/
  );
});

test("getRunHealth accepts the terminal degraded verdict without converting it to done", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "degraded-health-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const envelope = currentStatusEnvelope("ultrafuzz-degraded-health-run");
  const data = envelope.data as Record<string, unknown>;
  env.SMITHERS_FAKE_STATUS_JSON = JSON.stringify({
    ...envelope,
    data: {
      ...data,
      status: "finished",
      verdict: "degraded",
      reason: "loop review exhausted before its until condition passed",
      liveness: { state: "succeeded" },
      finishedAtMs: 2_000
    }
  });

  const health = await getRunHealth({ projectRoot: project, runId: "degraded-health-run", env });

  assert.equal(health.ok, true, JSON.stringify(health.diagnostics));
  assert.equal(health.value?.verdict, "degraded");
  assert.equal(health.value?.workflow_status, "finished");
  assert.match(health.value?.reason ?? "", /until condition/u);
});

test("getRunHealth binds the workflow health summary to the run it asked about", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "bound-health-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  env.SMITHERS_FAKE_STATUS_JSON = JSON.stringify(currentStatusEnvelope("ultrafuzz-another-run"));
  const foreign = await getRunHealth({ projectRoot: project, runId: "bound-health-run", env });
  assert.equal(foreign.ok, false);
  assert.deepEqual(
    foreign.diagnostics.map((diagnostic) => diagnostic.code),
    ["WORKFLOW_STATUS_INVALID"]
  );
});

test("getRunHealth rejects every noncurrent status envelope without fallback or filtering", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "strict-health-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const canonical = currentStatusEnvelope("ultrafuzz-strict-health-run");
  const canonicalData = canonical.data as Record<string, unknown>;
  const invalidDocuments: Array<{ label: string; value: unknown }> = [
    { label: "bare data compatibility envelope", value: canonicalData },
    { label: "extra envelope field", value: { ...canonical, legacy: true } },
    { label: "extra data field", value: { ...canonical, data: { ...canonicalData, legacy: true } } },
    { label: "wrong metadata command", value: { ...canonical, meta: { command: "inspect", duration: "1ms" } } },
    {
      label: "filtered model row",
      value: {
        ...canonical,
        data: {
          ...canonicalData,
          modelMix: [{ engine: "codex", model: "gpt-test", attempts: 3, quotaParked: false, legacy: true }]
        }
      }
    }
  ];

  for (const invalid of invalidDocuments) {
    env.SMITHERS_FAKE_STATUS_JSON = JSON.stringify(invalid.value);
    const health = await getRunHealth({ projectRoot: project, runId: "strict-health-run", env });
    assert.equal(health.ok, false, invalid.label);
    assert.equal(health.value, undefined, invalid.label);
    assert.deepEqual(
      health.diagnostics.map((diagnostic) => diagnostic.code),
      ["WORKFLOW_STATUS_INVALID"],
      invalid.label
    );
  }
});

test("getRunHealth accepts strict 0.34 orphan, cancel-pending, quota, and operation metadata shapes", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "health-034-shapes", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const envelope = currentStatusEnvelope("ultrafuzz-health-034-shapes");
  const base = envelope.data as Record<string, unknown>;

  for (const verdict of ["orphaned", "cancel-pending"] as const) {
    env.SMITHERS_FAKE_STATUS_JSON = JSON.stringify({
      ...envelope,
      data: {
        ...base,
        verdict,
        reason: `run is ${verdict}`,
        liveness: {
          state: verdict,
          unhealthy: { kind: "engine-heartbeat-stale", lastHeartbeatAt: "2026-08-13T00:00:00.000Z" }
        },
        startedBy: { harness: "codex", sessionId: "session-1", detected: true },
        attention: {
          operation: "time travel",
          opId: null,
          crossedCount: 2,
          blockingCount: 1,
          revertibleCount: 1,
          warningCount: 0,
          lateCompletion: false,
          archivedByOp: null,
          timestampMs: 2_000
        },
        information: { operation: "rewind", warningCount: 1, timestampMs: 2_001 },
        oneshotControl: { kind: "steer", status: "agent-acked", messageId: "message-1", timestampMs: 2_002 }
      }
    });
    const health = await getRunHealth({ projectRoot: project, runId: "health-034-shapes", env });
    assert.equal(health.ok, true, `${verdict}: ${JSON.stringify(health.diagnostics)}`);
    assert.equal(health.value?.verdict, verdict);
    assert.equal(health.value?.started_by?.session_id, "session-1");
    assert.equal(health.value?.attention?.crossed_count, 2);
    assert.equal(health.value?.oneshot_control?.message_id, "message-1");
  }

  env.SMITHERS_FAKE_STATUS_JSON = JSON.stringify({
    ...envelope,
    data: {
      ...base,
      status: "waiting-quota",
      verdict: "waiting-quota",
      reason: "5 tasks quota-parked",
      bottleneck: [
        { nodeId: "node-a", iteration: 0, state: "quota-parked", detail: null },
        { nodeId: "node-b", iteration: 0, state: "quota-parked", detail: null },
        { nodeId: "node-c", iteration: 0, state: "quota-parked", detail: null }
      ],
      bottleneckOmitted: 2,
      quota: { parkedCount: 5, parkedNodeIds: ["node-a", "node-b", "node-c"], resetAtMs: null },
      liveness: { state: "waiting-quota" }
    }
  });
  const quota = await getRunHealth({ projectRoot: project, runId: "health-034-shapes", env });
  assert.equal(quota.ok, true, JSON.stringify(quota.diagnostics));
  assert.equal(quota.value?.quota?.parked_count, 5);
  assert.equal(quota.value?.gating[0]?.state, "quota-parked");
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

test("startRun defaults detached admission to five minutes without overriding an explicit timeout", async () => {
  for (const explicitTimeout of [undefined, "1"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const timeoutLog = path.join(project, "detached-admission-timeout.log");
    const env = {
      ...fakeSmithersEnv(project),
      ...(explicitTimeout === undefined ? {} : { SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS: explicitTimeout }),
      SMITHERS_FAKE_ADMISSION_TIMEOUT_LOG: timeoutLog
    };

    const run = await startRun({
      projectRoot: project,
      runId: `detached-admission-timeout-${explicitTimeout ?? "default"}`,
      env
    });

    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    assert.equal(fs.readFileSync(timeoutLog, "utf8"), `${explicitTimeout ?? "300000"}\n`);
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

test("startRun preflights and isolates the dedicated OpenRouter credential while preserving the model ID", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const model = "~vendor/model.latest:free+preview@2026";

  const missing = await startRun({
    projectRoot: project,
    runId: "openrouter-missing-credential",
    agent: "OpenRouterAgent",
    model,
    env: fakeSmithersEnv(project)
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.diagnostics[0]?.code, "RUN_AGENT_CREDENTIAL_MISSING");
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "runs", "openrouter-missing-credential")), false);

  const environmentLog = path.join(project, "smithers-openrouter-environment.log");
  const env = {
    ...fakeSmithersEnv(project),
    SMITHERS_FAKE_OPENROUTER_ENV_LOG: environmentLog,
    OPENROUTER_API_KEY: "openrouter-agent-key",
    OPENAI_API_KEY: "unrelated-openai-key",
    ANTHROPIC_API_KEY: "unrelated-anthropic-key"
  };
  const run = await startRun({
    projectRoot: project,
    runId: "openrouter-api-environment",
    agent: "OpenRouterAgent",
    model,
    env
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(environmentLog, "utf8"), "openrouter-agent-key||\n");
  const taskManifest = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "tasks.json"), "utf8")
  ) as { tasks: Array<{ agent_ref?: string; model_name?: string; agentRef?: string; modelName?: string }> };
  const task = taskManifest.tasks.find((entry) => (entry.agent_ref ?? entry.agentRef) === "OpenRouterAgent");
  assert.equal(task?.model_name ?? task?.modelName, model);
});

test("startRun rejects cross-agent API-key retry chains before submission", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace("same_agent_attempts = 1", 'same_agent_attempts = 1\nagents = ["default", "deepseek"]'),
    "utf8"
  );
  const credentialLog = path.join(project, "smithers-retry-credential-environment.log");
  const run = await startRun({
    projectRoot: project,
    runId: "local-retry-agent-credentials",
    env: {
      ...fakeSmithersEnv(project),
      SMITHERS_FAKE_RETRY_CREDENTIAL_ENV_LOG: credentialLog,
      OPENAI_API_KEY: "primary-key",
      DEEPSEEK_API_KEY: "fallback-key"
    }
  });

  assert.equal(run.ok, false);
  assert.match(
    run.diagnostics[0]?.message ?? "",
    /cannot include API-key authentication until every rung has an isolated credential boundary/u
  );
  assert.equal(fs.existsSync(credentialLog), false);
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "runs", "local-retry-agent-credentials")), false);
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

test("sealed workflow artifacts module stages and exports the exact validator preflight parser", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sealed-validator-preflight-parser";
  const run = await startRun({ projectRoot: project, runId, env: fakeSmithersEnv(project) });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;

  const sealedArtifactsDist = path.join(evidence.executionSnapshot.root, "modules", "@ultrafuzz", "artifacts", "dist");
  assert.match(
    fs.readFileSync(path.join(sealedArtifactsDist, "index.js"), "utf8"),
    /export \* from "\.\/json-validator-preflight\.js";/u
  );
  assert.deepEqual(
    fs.readFileSync(path.join(sealedArtifactsDist, "json-validator-preflight.js")),
    fs.readFileSync(fileURLToPath(new URL("../../../artifacts/dist/json-validator-preflight.js", import.meta.url)))
  );
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
    /workflow execution dependency map does not match urn:ultrafuzz:schema:runtime:workflow-execution-dependencies:1/u
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
  const resumed = await resumeRun({
    projectRoot: project,
    runId: "snapshot-source-replacement",
    force: true,
    env
  });
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
    assert.match(
      malformedEvidence.diagnostics[0]?.message ?? "",
      /workflow control seal does not match urn:ultrafuzz:schema:runtime:workflow-control-integrity:2/u
    );
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
{{finding_reachability_vocabulary}}
{{finding_note_key_vocabulary}}
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
      `${JSON.stringify({ name: patch.packageName, version: SMITHERS_VERSION })}\n`,
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
  const options = {};
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
      for (const file of awaited) {
        assert.equal(
          fs.existsSync(file),
          true,
          `${path.basename(file)} was not published; detached log: ${fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "<missing>"}`
        );
      }

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
    fs.realpathSync(path.join(process.cwd(), "node_modules", "smthrs", "src", "index.js"))
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
    assert.equal(packageVersion, SMITHERS_VERSION, `${label} belongs to an unpinned release`);

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
        `re-check whether Smithers ${SMITHERS_VERSION} fixed this itself`
    );
    for (const absent of patch.upstreamAbsent) {
      assert.equal(
        contents.includes(absent),
        false,
        `${label} now contains ${JSON.stringify(absent)}, so Smithers ${SMITHERS_VERSION} may have ` +
          `addressed this itself; re-justify or retire the ${patch.id} workaround`
      );
    }
  }

  // Preserve the upstream 0.34 MDX/non-module leaf guard while adding stable
  // path identity to the graph hash. Dropping extname here would reintroduce
  // import scanning inside prompt prose and make otherwise valid resumes fail.
  const workflowHashSource = sourceByPatchId.get("workflow_hash_import");
  const workflowHashImportPatch = SMITHERS_COMPATIBILITY_PATCHES.find((patch) => patch.id === "workflow_hash_import");
  assert.ok(workflowHashSource?.includes("SCANNABLE_MODULE_EXTENSIONS"));
  assert.match(workflowHashImportPatch?.patched ?? "", /extname, relative/u);

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
    fs.readFileSync(path.join(process.cwd(), "node_modules", "smthrs", "package.json"), "utf8")
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
  writeFakeInstalledSmithers(project, { binTarget: `./${SMITHERS_BIN_PATH}` });

  const run = await startRun({
    projectRoot: project,
    runId: "published-smithers-bin-run",
    env: { PATH: "", SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(logPath, "utf8"), /up .*ultrafuzz-published-smithers-bin-run\.tsx/);
});

test("package-manager-owned Smithers manifests use bounded strict parsing and narrow projections", () => {
  const project = tempProject();
  const paths = writeFakeInstalledSmithers(project);
  const valid = {
    name: "smthrs",
    version: SMITHERS_VERSION,
    bin: { smithers: SMITHERS_BIN_PATH },
    future_package_manager_field: { retained_by_owner: true }
  };
  fs.writeFileSync(paths.packageJson, `${JSON.stringify(valid)}\n`, "utf8");
  const validPosture = inspectSmithersInstallation(project);
  assert.equal(validPosture.bundled_version, SMITHERS_VERSION);
  assert.equal(validPosture.required_version, SMITHERS_VERSION);
  assert.equal(validPosture.installed_version, SMITHERS_VERSION);
  assert.equal(validPosture.installed_bin_target, SMITHERS_BIN_PATH);
  assert.equal(validPosture.bin_path, paths.shim);
  assert.equal(validPosture.layout_error, null);

  fs.writeFileSync(
    paths.packageJson,
    `{"name":"smthrs","version":${JSON.stringify(
      SMITHERS_VERSION
    )},"bin":{"__proto__":"literal-package-manager-key","smithers":${JSON.stringify(
      SMITHERS_BIN_PATH
    )}},"peerDependencies":{"__proto__":"1.0.0"},"peerDependenciesMeta":{"__proto__":{"optional":true}}}\n`,
    "utf8"
  );
  const prototypeKeyPosture = inspectSmithersInstallation(project);
  assert.equal(prototypeKeyPosture.installed_version, SMITHERS_VERSION);
  assert.equal(prototypeKeyPosture.installed_bin_target, SMITHERS_BIN_PATH);
  assert.equal(prototypeKeyPosture.layout_error, null);
  assert.equal(({} as { optional?: unknown }).optional, undefined);

  const tooDeep = `${"[".repeat(34)}null${"]".repeat(34)}`;
  const malformed: Array<{ label: string; bytes: Buffer; expected: RegExp }> = [
    {
      label: "duplicate key",
      bytes: Buffer.from(
        `{"version":"${SMITHERS_VERSION}","version":"${SMITHERS_VERSION}","bin":{"smithers":"${SMITHERS_BIN_PATH}"}}`
      ),
      expected: /duplicate/iu
    },
    { label: "invalid UTF-8", bytes: Buffer.from([0x7b, 0xff, 0x7d]), expected: /UTF-8/iu },
    { label: "oversize", bytes: Buffer.alloc(1024 * 1024 + 1, 0x20), expected: /1048576-byte limit/iu },
    {
      label: "excessive depth",
      bytes: Buffer.from(`{"version":"${SMITHERS_VERSION}","future":${tooDeep}}`),
      expected: /nesting-depth limit of 32/iu
    },
    {
      label: "empty string bin",
      bytes: Buffer.from(`{"version":"${SMITHERS_VERSION}","bin":""}`),
      expected: /bin must be a non-empty string/iu
    }
  ];
  for (const fixture of malformed) {
    fs.writeFileSync(paths.packageJson, fixture.bytes);
    const posture = inspectSmithersInstallation(project);
    assert.equal(posture.installed_version, null, fixture.label);
    assert.match(posture.layout_error ?? "", fixture.expected, fixture.label);
  }
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
  assert.equal(installed.version, SMITHERS_VERSION);
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

test("generated workflow dependencies require exact runner pins while allowing typed custom packages", () => {
  assert.throws(
    () =>
      assertSmithersPackageManifest({
        dependencies: {
          smthrs: "^0.27.0",
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
          smthrs: SMITHERS_VERSION,
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
          smthrs: SMITHERS_VERSION,
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
  assert.throws(
    () =>
      assertSmithersPackageManifest({
        ...rendered,
        dependencies: { ...rendered.dependencies, "custom-agent-package": 123 }
      }),
    /must retain Ultrafuzz's exact runner versions/u
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

test("syncRun accepts canonical findings without rewriting them and manifests only verified publications", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
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
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH, "findings.json"]);
  const unverifiedSidecarPath = path.join(
    run.value!.run_root,
    "artifacts",
    "project-discovery",
    "agent-unverified-sidecar.json"
  );
  const unverifiedSidecarBytes = Buffer.from('{"unverified":true}\n', "utf8");
  fs.writeFileSync(unverifiedSidecarPath, unverifiedSidecarBytes);
  const findingsPath = path.join(run.value!.run_root, "artifacts", "project-discovery", "findings.json");
  const findingsBefore = fs.readFileSync(findingsPath);

  const sync = await syncRun({ projectRoot: project, runId: "sync-success", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded", JSON.stringify(sync.diagnostics));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    status?: string;
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.status, "succeeded");
  assert.equal(state.nodes?.["project-discovery"]?.status, "succeeded");
  assert.deepEqual(fs.readFileSync(findingsPath), findingsBefore);
  assert.deepEqual(fs.readFileSync(unverifiedSidecarPath), unverifiedSidecarBytes);
  const findings = JSON.parse(fs.readFileSync(findingsPath, "utf8")) as Array<{ source_node_id?: string }>;
  assert.equal(findings[0]?.source_node_id, "project-discovery");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json"), "utf8")
  ) as {
    schema_version?: string;
    files?: Array<{ path?: string }>;
    provenance?: { metadata?: unknown };
  };
  assert.equal(manifest.schema_version, "ultrafuzz.artifact-manifest.v3");
  assert.deepEqual(manifest.provenance?.metadata, { concrete_node_id: "project-discovery" });
  assert.deepEqual(manifest.files?.map((entry) => entry.path).sort(), ["findings.json", GENERIC_RUNTIME_MARKDOWN_PATH]);
  const events = fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8");
  assert.doesNotMatch(events, /findings-normalized/u);
  assert.match(events, /artifact-manifest-written/);
});

test("syncRun rejects a valid output swap after verifier publication without repairing either version", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-verifier-snapshot-swap";
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
  const run = await startRun({ projectRoot: project, runId: "sync-verifier-snapshot-swap", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const artifactDir = path.join(run.value!.run_root, "artifacts", "project-discovery");
  const findingsPath = path.join(artifactDir, "findings.json");
  const markerPath = path.join(run.value!.run_root, ".ultrafuzz-verification", "project-discovery.json");
  const markerBefore = fs.readFileSync(markerPath);
  const swappedFindings = [
    {
      schema_version: "ultrafuzz.finding.v2",
      id: "finding-project-discovery-swapped",
      title: "Different valid candidate issue",
      status: "candidate",
      severity_guess: "Low",
      confidence: "low",
      summary: "These valid bytes were not the bytes approved by the verifier.",
      source_node_id: "project-discovery"
    }
  ];
  const swappedBytes = Buffer.from(`${JSON.stringify(swappedFindings)}\n`, "utf8");
  fs.writeFileSync(findingsPath, swappedBytes);

  const sync = await syncRun({ projectRoot: project, runId: "sync-verifier-snapshot-swap", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  assert.ok(
    sync.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_VERIFICATION_AUTHORITY_INVALID" &&
        /changed after verifier approval/u.test(diagnostic.message)
    ),
    JSON.stringify(sync.diagnostics)
  );
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      {
        status?: string;
        provenance?: {
          output_contracts?: { ok?: boolean; missing?: string[]; artifact_manifest_sha256?: string };
          terminal_disposition?: unknown;
        };
      }
    >;
  };
  const node = state.nodes?.["project-discovery"];
  assert.equal(node?.status, "failed");
  assert.deepEqual(node?.provenance?.output_contracts, { ok: false, missing: [] });
  assert.deepEqual(node?.provenance?.terminal_disposition, {
    schema_version: "ultrafuzz.terminal-disposition.v1",
    kind: "task-output-validation-failure"
  });
  assert.equal(fs.existsSync(path.join(artifactDir, "artifact-manifest.json")), false);
  assert.deepEqual(fs.readFileSync(findingsPath), swappedBytes);
  assert.deepEqual(fs.readFileSync(markerPath), markerBefore);
});

test("syncRun persists a schema-valid failed node when controller manifest publication fails", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
  const workflowRunId = "ultrafuzz-sync-manifest-write-failure";
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
  const run = await startRun({ projectRoot: project, runId: "sync-manifest-write-failure", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH, "findings.json"]);
  const manifestPath = path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json");
  fs.mkdirSync(manifestPath);

  const sync = await syncRun({ projectRoot: project, runId: "sync-manifest-write-failure", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  assert.ok(
    sync.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_MANIFEST_WRITE_FAILED"),
    JSON.stringify(sync.diagnostics)
  );
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<
      string,
      {
        status?: string;
        provenance?: {
          output_contracts?: { ok?: boolean; missing?: string[]; artifact_manifest_sha256?: string };
          terminal_disposition?: unknown;
        };
      }
    >;
  };
  const node = state.nodes?.["project-discovery"];
  assert.equal(node?.status, "failed");
  assert.equal(node?.provenance?.output_contracts?.artifact_manifest_sha256, undefined);
  assert.deepEqual(node?.provenance?.output_contracts, { ok: false, missing: [] });
  assert.equal(node?.provenance?.terminal_disposition, undefined);
  assert.equal(fs.statSync(manifestPath).isDirectory(), true);
  assert.doesNotMatch(
    fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8"),
    /artifact-manifest-written/u
  );
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
  const invalidFindingsPath = path.join(run.value!.run_root, "artifacts", "project-discovery", "findings.json");
  fs.writeFileSync(invalidFindingsPath, `${JSON.stringify([{ title: "incomplete output" }])}\n`, "utf8");
  const invalidFindingsBefore = fs.readFileSync(invalidFindingsPath);

  const sync = await syncRun({ projectRoot: project, runId: "sync-invalid-output", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  assert.deepEqual(fs.readFileSync(invalidFindingsPath), invalidFindingsBefore);
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
    false
  );

  const repeated = await syncRun({ projectRoot: project, runId: "sync-invalid-output", env });
  assert.equal(repeated.ok, true, JSON.stringify(repeated.diagnostics));
  assert.equal(repeated.value?.status, "failed");
  assert.deepEqual(fs.readFileSync(invalidFindingsPath), invalidFindingsBefore);
  const repeatedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { provenance?: Record<string, unknown> }>;
  };
  assert.deepEqual(repeatedState.nodes?.["project-discovery"]?.provenance?.terminal_disposition, {
    schema_version: "ultrafuzz.terminal-disposition.v1",
    kind: "task-output-validation-failure"
  });
});

test("syncRun surfaces a terminal preparation wrapper failure as a failed durable node", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
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
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH]);

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
  writeOutOfOrderTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
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
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH]);
  writeRequiredArtifactSet(run.value!.run_root, "actors-flows", ["setup/actors-flows.md"]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-preparation-recovered", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded", JSON.stringify(sync.diagnostics));
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
      steps: [
        { id: "ultrafuzz-agent-tasks", state: "failed" },
        { id: "node:project-discovery", state: "pending" }
      ]
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
      steps: [
        { id: "ultrafuzz-agent-tasks", state: "failed" },
        { id: "node:project-discovery", state: "pending" }
      ]
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
      status: "cancelled",
      state: "cancelled",
      steps: [
        { id: "node:project-discovery", state: "finished", attempt: 1 },
        { id: "prepare:actors-flows", state: "cancelled", attempt: 1 },
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
  writeOutOfOrderTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
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
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH]);

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

test("syncRun accepts the runner's correlation envelope and rejects a mismatched one", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  // Every event the runner emits carries this trace envelope, so refusing it left
  // no real run syncable at all.
  const synced = async (runId: string, correlationAttempt: number, control: Parameters<typeof syncRun>[1] = {}) => {
    const workflowRunId = `ultrafuzz-${runId}`;
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
            inputTokens: 11,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            model: "gpt-correlated",
            agent: "codex",
            correlation: {
              runId: workflowRunId,
              workflowName: workflowRunId,
              nodeId: "node:project-discovery",
              iteration: 0,
              attempt: correlationAttempt
            }
          }
        },
        { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
        { type: "RunFinished" }
      ])
    });
    const run = await startRun({ projectRoot: project, runId, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
    return syncRun({ projectRoot: project, runId, env }, control);
  };

  const accepted = await synced("correlated-usage", 1);
  assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));

  // A trace envelope that names another attempt is a mixed-up event, not a
  // routing detail to ignore, so the read fails closed instead of accounting it.
  await assert.rejects(
    () => synced("correlated-usage-mismatch", 2),
    /correlation attempt disagrees with the reported usage/u
  );

  const observational = await synced("correlated-usage-mismatch-observational", 2, {
    tolerateInvalidEventStreams: true
  });
  assert.equal(observational.ok, false);
  assert.ok(
    observational.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_EVENTS_INVALID"),
    JSON.stringify(observational.diagnostics)
  );
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
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 12,
          cacheWriteTokens: 3,
          model: "gpt-cache-only",
          agent: "codex"
        }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
      { type: "RunFinished" }
    ])
  });
  env.ULTRAFUZZ_PRICING_CATALOG_URL = pricingCatalogDataUrl({
    openai: {
      models: {
        "gpt-cache-only": { cost: { input: 1, output: 1, cache_read: 0.5, cache_write: 2 } }
      }
    }
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
  assert.equal(metadata.accounting?.current?.pricing_complete, true);
  assert.equal(metadata.accounting?.current?.estimated_spend_usd, 0.000012);
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
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      model: "generated-model",
      agent: "generated-agent"
    }),
    event(2, 200, "TokenUsageReported", {
      nodeId: "node:project-discovery",
      iteration: 0,
      attempt: 1,
      inputTokens: 20,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      model: "generated-model",
      agent: "generated-agent"
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
      current?: { control_generation?: string; source_event_sequences?: number[]; total_tokens?: number };
      segments?: Array<{ control_generation?: string; source_event_sequences?: number[]; total_tokens?: number }>;
    };
  };
  assert.equal(metadata.accounting?.segments?.length, 1);
  assert.deepEqual(metadata.accounting?.current?.source_event_sequences, [1, 2]);
  assert.equal(metadata.accounting?.current?.total_tokens, 30);
  assert.match(metadata.accounting?.current?.control_generation ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(
    metadata.accounting?.segments?.[0]?.control_generation,
    metadata.accounting?.current?.control_generation
  );
});

test("syncRun appends unseen usage events to the current control segment", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const workflowRunId = "ultrafuzz-implicit-usage";
  const tokenEvent = (inputTokens: number, outputTokens: number) => ({
    type: "TokenUsageReported",
    nodeId: "node:project-discovery",
    attempt: 1,
    extra: {
      iteration: 0,
      inputTokens,
      outputTokens,
      model: "generated-model",
      agent: "generated-agent"
    }
  });
  const firstSegment = [
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1, extra: { iteration: 0 } },
    tokenEvent(10, 5),
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
    workflowEvents(workflowRunId, [...firstSegment, tokenEvent(20, 10)]),
    "utf8"
  );
  const second = await syncRun({ projectRoot: project, runId: "implicit-usage", env });
  const replayed = await syncRun({ projectRoot: project, runId: "implicit-usage", env });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));

  const metadata = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "run.json"), "utf8")) as {
    accounting?: {
      segments?: Array<{
        control_generation?: string;
        source_event_sequences?: number[];
        total_tokens?: number;
        event_count?: number;
      }>;
      cumulative?: { total_tokens?: number; event_count?: number };
    };
  };
  const segments = metadata.accounting?.segments ?? [];
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.total_tokens, 45);
  assert.equal(segments[0]?.event_count, 2);
  assert.deepEqual(segments[0]?.source_event_sequences, [1, 4]);
  assert.match(segments[0]?.control_generation ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(metadata.accounting?.cumulative?.total_tokens, 45);
  assert.equal(metadata.accounting?.cumulative?.event_count, 2);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "usage.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("syncRun rejects a malformed-present usage ledger without accounting fallback", async () => {
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

  const usagePath = path.join(run.value!.run_root, "usage.jsonl");
  const usageBefore = fs.readFileSync(usagePath);
  const metadataBefore = fs.readFileSync(path.join(run.value!.run_root, "run.json"));

  await assert.rejects(
    () => syncRun({ projectRoot: project, runId: "malformed-only-usage", env }),
    /usage ledger record 1 is invalid strict JSON/u
  );
  assert.deepEqual(fs.readFileSync(usagePath), usageBefore);
  assert.deepEqual(fs.readFileSync(path.join(run.value!.run_root, "run.json")), metadataBefore);
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
  writeSmallTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
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
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH, "findings.json"]);

  const first = await getRunStatus({ projectRoot: project, runId: "inspect-idempotent", env });
  const second = await getRunStatus({ projectRoot: project, runId: "inspect-idempotent", env });

  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  assert.equal(first.value?.status, "succeeded");
  assert.equal(second.value?.status, "succeeded");
  assert.equal(second.value?.events, first.value?.events);
});

test("syncRun rejects workspace-mirrored outputs without copying or repairing them", async () => {
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
  const statePath = path.join(run.value!.run_root, "state.json");
  const manifestPath = path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json");
  const canonicalMarkdownPath = path.join(
    run.value!.run_root,
    "artifacts",
    "project-discovery",
    "setup",
    "project-discovery.md"
  );
  const canonicalFindingsPath = path.join(run.value!.run_root, "artifacts", "project-discovery", "findings.json");
  const workspaceRunRoot = path.join(run.value!.run_root, "workspaces", "project-discovery");
  writeRequiredArtifactSet(workspaceRunRoot, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const mirroredMarkdownPath = path.join(
    workspaceRunRoot,
    "artifacts",
    "project-discovery",
    "setup",
    "project-discovery.md"
  );
  const mirroredFindingsPath = path.join(workspaceRunRoot, "artifacts", "project-discovery", "findings.json");
  const mirroredMarkdownBefore = fs.readFileSync(mirroredMarkdownPath);
  const mirroredFindingsBefore = fs.readFileSync(mirroredFindingsPath);

  const first = await syncRun({ projectRoot: project, runId: "sync-missing", env });

  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.equal(first.value?.status, "failed");
  assert.ok(first.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_VERIFICATION_AUTHORITY_INVALID"));
  const firstState = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    status?: string;
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
  const firstNode = structuredClone(firstState.nodes?.["project-discovery"]);
  assert.equal(firstState.status, "failed");
  assert.equal(firstNode?.status, "failed");
  assert.match(firstNode?.last_error ?? "", /artifact verification marker does not exist/u);
  assert.deepEqual(firstNode?.provenance?.failure, {
    category: "artifact-contract",
    causal_task_id: "verify:project-discovery",
    causal_failure_category: "artifact-contract",
    dependent_task_ids: []
  });
  assert.deepEqual(firstNode?.provenance?.terminal_disposition, {
    schema_version: "ultrafuzz.terminal-disposition.v1",
    kind: "task-output-validation-failure"
  });
  assert.equal(fs.existsSync(manifestPath), false);
  assert.equal(fs.existsSync(canonicalMarkdownPath), false);
  assert.equal(fs.existsSync(canonicalFindingsPath), false);
  assert.deepEqual(fs.readFileSync(mirroredMarkdownPath), mirroredMarkdownBefore);
  assert.deepEqual(fs.readFileSync(mirroredFindingsPath), mirroredFindingsBefore);

  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", ["setup/project-discovery.md", "findings.json"]);
  const second = await syncRun({ projectRoot: project, runId: "sync-missing", env });

  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  assert.equal(second.value?.status, "failed");
  const secondState = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    nodes?: Record<string, unknown>;
  };
  assert.deepEqual(secondState.nodes?.["project-discovery"], firstNode);
  assert.equal(fs.existsSync(manifestPath), false);
  assert.deepEqual(fs.readFileSync(mirroredMarkdownPath), mirroredMarkdownBefore);
  assert.deepEqual(fs.readFileSync(mirroredFindingsPath), mirroredFindingsBefore);
  const durableEvents = fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8");
  assert.doesNotMatch(durableEvents, /reconcil|repair/iu);
  assert.doesNotMatch(JSON.stringify(secondState.nodes?.["project-discovery"]), /reconcil|repair/iu);
});

test("syncRun honors cancellation and an overall deadline before terminal synchronization", async () => {
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

test("syncRun seals reproducible verifier output failures as terminal without changing authored bytes", async () => {
  for (const variant of ["schema-invalid", "missing"] as const) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const workflowRunId = `ultrafuzz-sync-verifier-output-${variant}`;
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
          error: { message: `artifact-contract failure: ${variant} findings.json` }
        }
      ])
    });
    const run = await startRun({ projectRoot: project, runId: `sync-verifier-output-${variant}`, env });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [
      "setup/project-discovery.md",
      ...(variant === "schema-invalid" ? ["findings.json"] : [])
    ]);
    const artifactRoot = path.join(run.value!.run_root, "artifacts", "project-discovery");
    const markdownPath = path.join(artifactRoot, "setup", "project-discovery.md");
    const findingsPath = path.join(artifactRoot, "findings.json");
    if (variant === "schema-invalid") fs.writeFileSync(findingsPath, "{}\n", "utf8");
    const markdownBefore = fs.readFileSync(markdownPath);
    const findingsBefore = variant === "schema-invalid" ? fs.readFileSync(findingsPath) : undefined;

    const sync = await syncRun({ projectRoot: project, runId: `sync-verifier-output-${variant}`, env });

    assert.equal(sync.ok, true, `${variant}: ${JSON.stringify(sync.diagnostics)}`);
    assert.equal(sync.value?.status, "failed");
    const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
      nodes?: Record<
        string,
        {
          status?: string;
          provenance?: {
            output_contracts?: { ok?: boolean; missing?: string[] };
            terminal_disposition?: unknown;
          };
        }
      >;
    };
    const node = state.nodes?.["project-discovery"];
    assert.equal(node?.status, "failed");
    assert.equal(node?.provenance?.output_contracts?.ok, false);
    assert.deepEqual(node?.provenance?.output_contracts?.missing, variant === "missing" ? ["findings.json"] : []);
    assert.deepEqual(node?.provenance?.terminal_disposition, {
      schema_version: "ultrafuzz.terminal-disposition.v1",
      kind: "task-output-validation-failure"
    });
    assert.deepEqual(fs.readFileSync(markdownPath), markdownBefore);
    if (findingsBefore === undefined) assert.equal(fs.existsSync(findingsPath), false);
    else assert.deepEqual(fs.readFileSync(findingsPath), findingsBefore);
  }
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
  const attemptLedgerPath = path.join(run.value!.run_root, "attempts.jsonl");
  assert.equal(
    fs.existsSync(attemptLedgerPath) ? fs.readFileSync(attemptLedgerPath, "utf8").trim() : "",
    "",
    "an agent success must not become an immutable phantom attempt before verifier evidence exists"
  );
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.notEqual(state.nodes?.["project-discovery"]?.status, "succeeded");
});

test("syncRun finalizes prerequisite manifests before out-of-order descendants", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOutOfOrderTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
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
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH]);
  writeRequiredArtifactSet(run.value!.run_root, "actors-flows", ["setup/actors-flows.md"]);
  const undeclaredFindingsPath = path.join(run.value!.run_root, "artifacts", "actors-flows", "findings.json");
  fs.writeFileSync(undeclaredFindingsPath, "{not-json\n", "utf8");
  const undeclaredFindingsBefore = fs.readFileSync(undeclaredFindingsPath);

  const sync = await syncRun({ projectRoot: project, runId: "sync-out-of-order", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded");
  assert.deepEqual(fs.readFileSync(undeclaredFindingsPath), undeclaredFindingsBefore);
  assert.doesNotMatch(fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8"), /findings-validated/u);
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
    inspect: workflowInspect({ workflowRunId, steps: [] }),
    events: ""
  });
  const run = await startRun({ projectRoot: project, runId: "sync-missing-evidence", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "sync-missing-evidence", env });

  assert.equal(sync.ok, true);
  assert.equal(sync.value?.status, "failed");
  assert.ok(sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_TASK_EVIDENCE_MISSING"));
});

test("syncRun persists exhausted-loop evidence and fails a completed degraded workflow", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-sync-degraded-loop";
  const exhaustedLoops = [{ id: "review", iteration: 3, maxIterations: 3 }];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      exhaustedLoops,
      steers: [
        {
          steerId: "steer-1",
          nodeId: "node:project-discovery",
          status: "consumed",
          message: "focus the final pass",
          author: "operator",
          queued: "2026-07-03T00:00:01.000Z",
          consumedByAttempt: 1,
          consumedByIteration: 0
        }
      ],
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 1 },
      { type: "RunFinished", extra: { exhaustedLoops } }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-degraded-loop", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-degraded-loop", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed");
  const events = fs.readFileSync(path.join(run.value!.run_root, "events.jsonl"), "utf8");
  assert.match(events, /"exhausted_loops":\[\{"id":"review","iteration":3,"max_iterations":3\}\]/u);
});

test("syncRun maps failed workflow nodes into durable failed run state", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs.readFileSync(configPath, "utf8").replace("same_agent_attempts = 1", "same_agent_attempts = 2"),
    "utf8"
  );
  const workflowRunId = "ultrafuzz-sync-failed-node";
  const failedEvents = [
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
    { type: "TaskHeartbeatTimeout", nodeId: "node:project-discovery", attempt: 1 },
    { type: "NodeFailed", nodeId: "node:project-discovery", attempt: 1, error: { message: "agent failed" } },
    { type: "NodeRetrying", nodeId: "node:project-discovery", attempt: 2 },
    { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 2 },
    { type: "NodeFailed", nodeId: "node:project-discovery", attempt: 2, error: { message: "agent failed again" } }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 2 }]
    }),
    events: workflowEvents(workflowRunId, failedEvents),
    attemptSelections: {
      "node:project-discovery": {
        1: { chainIndex: 0, profileId: "default", model: "gpt-5.5" },
        2: { chainIndex: 1, profileId: "default", model: "gpt-5.5" }
      }
    }
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
    ["failed", "failed"]
  );
  assert.deepEqual(
    failedLedger.map((entry) => entry.failure_message),
    ["agent failed", "agent failed again"]
  );
  assert.deepEqual(
    failedLedger.map((entry) => entry.agent),
    [0, 1].map((chainIndex) => ({
      chain_index: chainIndex,
      profile_id: "default",
      agent_ref: "CodexAgent",
      model_name: "gpt-5.5",
      reasoning_effort: "xhigh",
      role: "primary",
      selection: "observed"
    }))
  );
});

test("syncRun records failed primaries and the actual fallback producer", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace("same_agent_attempts = 1", 'same_agent_attempts = 3\nagents = ["sol-xhigh", "gpt55-xhigh"]')
      .replace(
        "[models.claude]",
        '[models.sol-xhigh]\nagent = "CodexAgent"\nmodel = "gpt-5.6-sol"\nreasoning = "xhigh"\n\n' +
          '[models.gpt55-xhigh]\nagent = "CodexAgent"\nmodel = "gpt-5.5"\nreasoning = "xhigh"\n\n' +
          "[models.claude]"
      ),
    "utf8"
  );
  const workflowRunId = "ultrafuzz-fallback-provenance";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: "node:project-discovery", state: "finished", attempt: 4 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFailed", nodeId: "node:project-discovery", attempt: 1, error: { message: "opaque one" } },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 2 },
      { type: "NodeFailed", nodeId: "node:project-discovery", attempt: 2, error: { message: "opaque two" } },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 3 },
      { type: "NodeFailed", nodeId: "node:project-discovery", attempt: 3, error: { message: "opaque three" } },
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 4 },
      {
        type: "TokenUsageReported",
        nodeId: "node:project-discovery",
        attempt: 4,
        extra: { model: "gpt-5.5", agent: "codex", inputTokens: 10, outputTokens: 5 }
      },
      { type: "NodeFinished", nodeId: "node:project-discovery", attempt: 4 },
      { type: "RunFinished" }
    ]),
    attemptSelections: {
      "node:project-discovery": {
        1: { chainIndex: 0, profileId: "sol-xhigh", model: "gpt-5.6-sol" },
        2: { chainIndex: 1, profileId: "sol-xhigh", model: "gpt-5.6-sol" },
        3: { chainIndex: 2, profileId: "sol-xhigh", model: "gpt-5.6-sol" },
        4: { chainIndex: 3, profileId: "gpt55-xhigh", model: "gpt-5.5" }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "fallback-provenance", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH, "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "fallback-provenance", env });
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const attemptsBytes = fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8").trim();
  assert.notEqual(attemptsBytes, "", JSON.stringify(sync.diagnostics));
  const attempts = attemptsBytes
    .split("\n")
    .map((line) => JSON.parse(line) as { outcome?: string; agent?: Record<string, unknown> });
  assert.deepEqual(
    attempts.map((entry) => [entry.outcome, entry.agent?.chain_index, entry.agent?.profile_id, entry.agent?.role]),
    [
      ["failed", 0, "sol-xhigh", "primary"],
      ["failed", 1, "sol-xhigh", "primary"],
      ["failed", 2, "sol-xhigh", "primary"],
      ["succeeded", 3, "gpt55-xhigh", "fallback"]
    ]
  );
  assert.deepEqual(attempts[3]?.agent, {
    chain_index: 3,
    profile_id: "gpt55-xhigh",
    agent_ref: "CodexAgent",
    model_name: "gpt-5.5",
    reasoning_effort: "xhigh",
    role: "fallback",
    selection: "observed"
  });
});

test("syncRun trusts non-ordinal Smithers selection when opaque profiles share a model", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace("same_agent_attempts = 1", 'same_agent_attempts = 1\nagents = ["shared-a", "shared-b", "shared-c"]')
      .replace(
        "[models.claude]",
        '[models.shared-a]\nagent = "CodexAgent"\nmodel = "shared-model"\nreasoning = "xhigh"\n\n' +
          '[models.shared-b]\nagent = "CodexAgent"\nmodel = "shared-model"\nreasoning = "xhigh"\n\n' +
          '[models.shared-c]\nagent = "CodexAgent"\nmodel = "shared-model"\nreasoning = "xhigh"\n\n' +
          "[models.claude]"
      ),
    "utf8"
  );
  const workflowRunId = "ultrafuzz-non-ordinal-provenance";
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
    attemptSelections: {
      "node:project-discovery": {
        1: { chainIndex: 2, profileId: "shared-c", model: "shared-model" }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "non-ordinal-provenance", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH, "findings.json"]);

  const sync = await syncRun({ projectRoot: project, runId: "non-ordinal-provenance", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  const attempts = fs
    .readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { agent?: Record<string, unknown> });
  assert.deepEqual(attempts[0]?.agent, {
    chain_index: 2,
    profile_id: "shared-c",
    agent_ref: "CodexAgent",
    model_name: "shared-model",
    reasoning_effort: "xhigh",
    role: "fallback",
    selection: "observed"
  });
});

test("syncRun fails closed when Smithers selection does not match the sealed chain", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-mismatched-selection";
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
    attemptSelections: {
      "node:project-discovery": {
        1: { chainIndex: 0, profileId: "forged-profile", model: "gpt-5.5" }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "mismatched-selection", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId: "mismatched-selection", env });

  assert.equal(sync.ok, false);
  assert.deepEqual(
    sync.diagnostics.map((diagnostic) => diagnostic.code),
    ["WORKFLOW_ATTEMPT_INSPECT_FAILED"]
  );
  assert.match(sync.diagnostics[0]?.message ?? "", /agent ID does not match sealed chain rung 0/u);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8"), "");
});

test("syncRun rejects forged provenance in an existing immutable attempt", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
  const workflowRunId = "ultrafuzz-forged-recorded-provenance";
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
  const run = await startRun({ projectRoot: project, runId: "forged-recorded-provenance", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH, "findings.json"]);

  const firstSync = await syncRun({ projectRoot: project, runId: "forged-recorded-provenance", env });
  assert.equal(firstSync.ok, true, JSON.stringify(firstSync.diagnostics));
  const ledgerPath = path.join(run.value!.run_root, "attempts.jsonl");
  const entry = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
  entry.agent = {
    chain_index: 0,
    profile_id: "default",
    agent_ref: "CodexAgent",
    model_name: "forged-model",
    reasoning_effort: "xhigh",
    role: "primary",
    selection: "observed"
  };
  const forgedLedger = `${JSON.stringify(entry)}\n`;
  fs.writeFileSync(ledgerPath, forgedLedger, "utf8");

  const replayed = await syncRun({ projectRoot: project, runId: "forged-recorded-provenance", env });

  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.ok(replayed.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  assert.match(
    replayed.diagnostics.find((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED")?.message ?? "",
    /already recorded with different immutable data/u
  );
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), forgedLedger);
  assert.equal(
    fs
      .readFileSync(env.SMITHERS_FAKE_LOG!, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("node node:project-discovery ")).length,
    2
  );
});

test("syncRun rejects a legacy agentless immutable local attempt", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
  const workflowRunId = "ultrafuzz-agentless-recorded-provenance";
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
  const run = await startRun({ projectRoot: project, runId: "agentless-recorded-provenance", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH, "findings.json"]);

  const firstSync = await syncRun({ projectRoot: project, runId: "agentless-recorded-provenance", env });
  assert.equal(firstSync.ok, true, JSON.stringify(firstSync.diagnostics));
  const ledgerPath = path.join(run.value!.run_root, "attempts.jsonl");
  const entry = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
  delete entry.agent;
  const legacyLedger = `${JSON.stringify(entry)}\n`;
  fs.writeFileSync(ledgerPath, legacyLedger, "utf8");

  const replayed = await syncRun({ projectRoot: project, runId: "agentless-recorded-provenance", env });

  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.ok(replayed.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  assert.match(
    replayed.diagnostics.find((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED")?.message ?? "",
    /already recorded with different immutable data/u
  );
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), legacyLedger);
  assert.equal(
    fs
      .readFileSync(env.SMITHERS_FAKE_LOG!, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("node node:project-discovery ")).length,
    2
  );
});

test("syncRun records a terminal attempt when its start event arrives later", async () => {
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
  assert.equal(initialLedger, "");
  const completedLedger = fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8");
  assert.equal(completedLedger.trim().split("\n").length, 1);
  const entry = JSON.parse(completedLedger) as Record<string, unknown>;
  assert.equal(entry.started_event_sequence, 1);
  assert.equal(entry.source_event_sequence, 2);
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
        status: "cancelled",
        state: "cancelled",
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
  writeFanoutProject(project, GENERIC_RUNTIME_MARKDOWN_PATH);
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
      { type: "NodeStarted", nodeId: "node:project-discovery__model_0__attempt_0", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:project-discovery__model_0__attempt_0", attempt: 1 },
      { type: "NodeStarted", nodeId: "node:project-discovery__model_1__attempt_1", attempt: 1 },
      {
        type: "NodeFailed",
        nodeId: "node:project-discovery__model_1__attempt_1",
        attempt: 1,
        error: { message: "model failed" }
      },
      { type: "NodeStarted", nodeId: "node:signal-analysis__model_0__attempt_0", attempt: 1 },
      { type: "NodeSkipped", nodeId: "node:signal-analysis__model_1__attempt_1", attempt: 1 }
    ]),
    attemptSelections: {
      "node:project-discovery__model_0__attempt_0": {
        1: { chainIndex: 0, profileId: "fast", model: "gpt-test-fast" }
      },
      "node:project-discovery__model_1__attempt_1": {
        1: { chainIndex: 0, profileId: "deep", model: "gpt-test-deep" }
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId: "sync-fanout", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery__model_0__attempt_0", [
    GENERIC_RUNTIME_MARKDOWN_PATH,
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
  assert.equal(
    state.nodes?.["project-discovery__model_0__attempt_0"]?.status,
    "succeeded",
    JSON.stringify(sync.diagnostics)
  );
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
  const retryConfigPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    retryConfigPath,
    fs
      .readFileSync(retryConfigPath, "utf8")
      .replace("same_agent_attempts = 1", 'same_agent_attempts = 1\nagents = ["default", "lifecycle-fallback"]')
      .replace(
        "[models.claude]",
        '[models.lifecycle-fallback]\nagent = "CodexAgent"\nmodel = "gpt-5.6-sol"\nreasoning = "xhigh"\n\n' +
          "[models.claude]"
      ),
    "utf8"
  );
  const env = fakeSmithersEnv(project);
  const credentialLog = path.join(project, "lifecycle-credential-env.log");
  const retryCredentialLog = path.join(project, "lifecycle-retry-credential-env.log");
  const hostileCredential = "must-not-cross-sealed-lifecycle-boundary";
  env.AWS_SECRET_ACCESS_KEY = hostileCredential;
  env.OPENAI_API_KEY = "sealed-primary-key";
  env.DEEPSEEK_API_KEY = "sealed-fallback-key";
  env.SMITHERS_FAKE_ENV_LOG = credentialLog;
  env.SMITHERS_FAKE_RETRY_CREDENTIAL_ENV_LOG = retryCredentialLog;
  const run = await startRun({ projectRoot: project, runId: "lifecycle-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(retryCredentialLog, "utf8"), "sealed-primary-key|\n");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  fs.writeFileSync(credentialLog, "", "utf8");
  fs.writeFileSync(retryCredentialLog, "", "utf8");
  const sealedPlan = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "plan.json"), "utf8")) as {
    rendered_prompts: Array<{
      rendered_prompt_path: string;
      rendered_prompt_snapshot_path: string;
    }>;
  };
  const missingPrompt = sealedPlan.rendered_prompts[0]!;
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

  const resumed = await resumeRun({
    projectRoot: project,
    runId: run.value!.run_id,
    maxConcurrency: 8,
    force: true,
    env
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.workflow_run_id, "ultrafuzz-lifecycle-run");
  assert.equal(resumed.value?.submitted, true);
  assert.equal(fs.readFileSync(retryCredentialLog, "utf8"), "sealed-primary-key|\n");
  assert.equal(fs.existsSync(missingPrompt.rendered_prompt_path), false);
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
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run --run-id ultrafuzz-lifecycle-run --force --detach --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/
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

test("a duplicate-key workflow link journal is terminal and is never rewritten or treated as missing", async () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  writeSmallTopology(project);
  const runId = "duplicate-key-workflow-link";
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const journalPath = path.join(run.value!.run_root, "smithers", "workflow-run-link-journal.json");
  const original = fs.readFileSync(journalPath, "utf8");
  const duplicated = original.replace(
    '"schema_version": "ultrafuzz.workflow-run-link-journal.v1",',
    '"schema_version": "ultrafuzz.workflow-run-link-journal.v1",\n  "schema_version": "ultrafuzz.workflow-run-link-journal.v1",'
  );
  assert.notEqual(duplicated, original);
  fs.writeFileSync(journalPath, duplicated, "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const evidence = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(evidence.ok, false);
  if (!evidence.ok) {
    assert.equal(evidence.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
    assert.match(evidence.diagnostics[0]?.message ?? "", /duplicate property name/u);
  }
  const resumed = await resumeRun({ projectRoot: project, runId, env });
  assert.equal(resumed.ok, false);
  assert.equal(resumed.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
  assert.equal(fs.readFileSync(journalPath, "utf8"), duplicated);
  assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), "");
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
  delete state.provenance;
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
      steps: [{ id: "node:project-discovery", state: "in-progress", attempt: 1 }]
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
  assert.match(commands, /inspect ultrafuzz-active-lifecycle-run --format json --full-output/u);
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

test("resume rejects non-current Smithers inspect evidence before making lifecycle decisions", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const workflowRunId = "ultrafuzz-strict-resume-inspect";
  const validInspect = workflowInspect({
    workflowRunId,
    status: "running",
    state: "running",
    steps: [{ id: "node:project-discovery", state: "in-progress", attempt: 1 }]
  });
  const env = fakeLifecycleSmithersEnv(project, { inspect: validInspect });
  const run = await startRun({ projectRoot: project, runId: "strict-resume-inspect", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  interface MutableInspectFixture {
    ok?: unknown;
    data: {
      run?: Record<string, unknown>;
      runState?: Record<string, unknown>;
      steps?: unknown;
      nodes?: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    meta?: Record<string, unknown>;
    [key: string]: unknown;
  }
  const invalidInspect = (mutate: (fixture: MutableInspectFixture) => void): MutableInspectFixture => {
    const fixture = structuredClone(validInspect) as MutableInspectFixture;
    mutate(fixture);
    return fixture;
  };
  const contradictoryLegacySteps = invalidInspect((fixture) => {
    fixture.data.steps = [
      { id: "node:project-discovery", state: "failed", attempt: 99, label: "legacy row must stay inert" }
    ];
  });
  fs.writeFileSync(env.SMITHERS_FAKE_INSPECT!, `${JSON.stringify(contradictoryLegacySteps)}\n`, "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const ignoredLegacyCompanion = await resumeRun({ projectRoot: project, runId: "strict-resume-inspect", env });

  assert.equal(ignoredLegacyCompanion.ok, true, JSON.stringify(ignoredLegacyCompanion.diagnostics));
  assert.equal(ignoredLegacyCompanion.value?.submitted, false);
  assert.doesNotMatch(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /^(?:up|timetravel) /mu);

  const cases: Array<{
    label: string;
    inspect: MutableInspectFixture;
    message: RegExp;
  }> = [
    {
      label: "missing full-output metadata",
      inspect: invalidInspect((fixture) => delete fixture.meta),
      message: /exact current full-output envelope/u
    },
    {
      label: "wrong metadata command",
      inspect: invalidInspect((fixture) => {
        fixture.meta!.command = "status";
      }),
      message: /metadata command must be inspect/u
    },
    {
      label: "missing canonical run state",
      inspect: invalidInspect((fixture) => delete fixture.data.runState),
      message: /missing current required fields: runState/u
    },
    {
      label: "unknown run state",
      inspect: invalidInspect((fixture) => {
        fixture.data.runState!.state = "unknown";
      }),
      message: /runState\.state is unknown/u
    },
    {
      label: "removed run-state alias",
      inspect: invalidInspect((fixture) => {
        fixture.data.runState!.state = "active";
      }),
      message: /runState\.state is not a current supported value/u
    },
    {
      label: "steps-only compatibility shape",
      inspect: invalidInspect((fixture) => delete fixture.data.nodes),
      message: /missing current required fields: nodes/u
    },
    {
      label: "missing ignored steps companion",
      inspect: invalidInspect((fixture) => delete fixture.data.steps),
      message: /missing current required fields: steps/u
    },
    {
      label: "removed tasks shape",
      inspect: invalidInspect((fixture) => {
        fixture.data.tasks = fixture.data.nodes;
      }),
      message: /removed field aliases: tasks/u
    },
    {
      label: "unknown data field",
      inspect: invalidInspect((fixture) => {
        fixture.data.result = [];
      }),
      message: /data contains fields outside the pinned 0\.34\.0 shape: result/u
    },
    {
      label: "unknown run field",
      inspect: invalidInspect((fixture) => {
        fixture.data.run!.phase = "running";
      }),
      message: /data\.run contains fields outside the pinned 0\.34\.0 shape: phase/u
    },
    {
      label: "unknown run-state field",
      inspect: invalidInspect((fixture) => {
        fixture.data.runState!.status = "running";
      }),
      message: /data\.runState contains fields outside the pinned 0\.34\.0 shape: status/u
    },
    {
      label: "removed node-state alias",
      inspect: invalidInspect((fixture) => {
        fixture.data.nodes![0]!.state = "running";
      }),
      message: /nodes\[0\]\.state is not a current supported value/u
    },
    {
      label: "failed child outside canonical nodes",
      inspect: invalidInspect((fixture) => {
        fixture.data.failedChildren = 1;
        fixture.data.failedChildKeys = ["node:missing::0"];
      }),
      message: /failedChildKeys\[0\] does not name a canonical node/u
    }
  ];

  for (const invalid of cases) {
    fs.writeFileSync(env.SMITHERS_FAKE_INSPECT!, `${JSON.stringify(invalid.inspect)}\n`, "utf8");
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

    const resumed = await resumeRun({ projectRoot: project, runId: "strict-resume-inspect", env });

    assert.equal(resumed.ok, false, invalid.label);
    assert.equal(resumed.diagnostics[0]?.code, "WORKFLOW_LIFECYCLE_FAILED", invalid.label);
    assert.match(resumed.diagnostics[0]?.message ?? "", invalid.message, invalid.label);
    const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
    assert.match(commands, /inspect ultrafuzz-strict-resume-inspect --format json --full-output/u, invalid.label);
    assert.doesNotMatch(commands, /^(?:up|timetravel) /mu, invalid.label);
  }
});

test("resume derives reset identities from the canonical nodes of a failed workflow", async () => {
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

  // The runner derives `failedChildKeys` only for a success-terminal run, so a
  // genuinely failed run never carries them and retrying one used to be refused
  // outright. Its canonical `nodes` array names the failed node exactly, and
  // topology expansion gives each loop iteration its own concrete node, so the
  // node id identifies the attempt to reset without guessing an iteration.
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /inspect ultrafuzz-terminal-retry-run --format json --full-output/u);
  assert.match(
    commands,
    /timetravel .* --run-id ultrafuzz-terminal-retry-run --node-id node:project-discovery --iteration 0/u
  );
  // Only the failed node is reset; a pending sibling is left alone.
  assert.doesNotMatch(commands, /--node-id node:strategy/u);

  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  const resetByNode = await resumeRun({
    projectRoot: project,
    runId: "terminal-retry-run",
    resetNode: "node:project-discovery",
    env
  });
  assert.equal(resetByNode.ok, true, JSON.stringify(resetByNode.diagnostics));
  assert.match(
    fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"),
    /timetravel .* --run-id ultrafuzz-terminal-retry-run --node-id node:project-discovery --iteration 0 --no-vcs --force --format json/u
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

test("resume renews a stale unfinished run without synthesizing a task reset", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-stale-retry-run",
      status: "running",
      state: "stale",
      steps: [
        { id: "node:project-discovery", state: "pending", attempt: 1 },
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
  assert.match(commands, /inspect ultrafuzz-stale-retry-run --format json --full-output/u);
  assert.doesNotMatch(commands, /^timetravel /mu);
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
      state: "running",
      steps: [{ id: "node:project-discovery", state: "in-progress", attempt: 2 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "retrying-lifecycle-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  for (const [state, nodeState] of [
    ["running", "in-progress"],
    ["waiting-approval", "waiting-approval"],
    ["waiting-event", "waiting-event"],
    ["waiting-timer", "waiting-timer"],
    ["recovering", "in-progress"]
  ] as const) {
    fs.writeFileSync(
      env.SMITHERS_FAKE_INSPECT!,
      `${JSON.stringify(
        workflowInspect({
          workflowRunId: "ultrafuzz-retrying-lifecycle-run",
          status: "running",
          state,
          steps: [{ id: "node:project-discovery", state: nodeState, attempt: 2 }]
        })
      )}\n`,
      "utf8"
    );
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

    const resumed = await resumeRun({ projectRoot: project, runId: "retrying-lifecycle-run", env });

    assert.equal(resumed.ok, true, `${state}: ${JSON.stringify(resumed.diagnostics)}`);
    assert.equal(resumed.value?.submitted, false, `state ${state} must suppress duplicate resume`);
    const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
    assert.match(commands, /inspect ultrafuzz-retrying-lifecycle-run --format json --full-output/u);
    assert.doesNotMatch(commands, /^up /mu, `state ${state} must not launch a duplicate up --resume`);
  }
});

test("resume keeps a quota-waiting workflow attached without launching a duplicate", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: "ultrafuzz-quota-resume-run",
      status: "waiting-quota",
      state: "waiting-quota",
      steps: [{ id: "node:project-discovery", state: "waiting-quota", attempt: 1 }]
    })
  });
  const run = await startRun({ projectRoot: project, runId: "quota-resume-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({ projectRoot: project, runId: "quota-resume-run", env });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, false);
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /inspect ultrafuzz-quota-resume-run --format json --full-output/u);
  assert.doesNotMatch(commands, /^up /mu);
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
      '  printf \'%s\\n\' \'{"ok":false,"error":{"code":"RUN_NOT_FOUND","message":"No Smithers run history found at /workspace/target/smithers.db. Run \'\\\'\'smithers up <workflow>\'\\\'\' to start a run first."}}\'',
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
  assert.equal(initial.diagnostics[0]?.code, "WORKFLOW_SUBMISSION_FAILED");
  assert.equal(initial.diagnostics[0]?.details?.exit_code, 42);
  const runRoot = path.join(project, ".ultrafuzz", "runs", "missing-workflow-run");
  assert.equal(
    fs.existsSync(path.join(runRoot, "smithers", "control-integrity.json")),
    true,
    "the canonical start helper must publish exact sealed control evidence before submission"
  );
  const sealedEvidence = await readLinkedWorkflowEvidence(project, "missing-workflow-run");
  assert.equal(
    sealedEvidence.ok,
    true,
    "diagnostics" in sealedEvidence ? JSON.stringify(sealedEvidence.diagnostics) : ""
  );
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
  if (!fs.existsSync(path.join(workspaceRoot(), ".smithers", "node_modules", "smthrs"))) {
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
