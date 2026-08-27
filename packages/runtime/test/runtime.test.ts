import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  execFileSync,
  spawn,
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
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

import { test, testWhen } from "./runtime-test-shard.js";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  appendNodeAttempts,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  artifactSchemaBundleDigest,
  artifactSchemaRegistry,
  artifactSchemaRegistryFromDirectory,
  ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
  GOAL_PLAN_JSON_SCHEMA_ID,
  THREAT_MODEL_JSON_SCHEMA_ID,
  appendEvent,
  createEventRecord,
  goalPlanJsonSchema,
  layoutForRunRoot,
  manifestDigest,
  readPlannedGraphDocument,
  readRunState,
  promptArtifactAuthorityPathSelectorId,
  replayEvents,
  threatModelJsonSchema,
  validateRegisteredJsonBytesSync,
  VALIDATOR_BUILD_IDENTITY,
  writeRunState,
  type RunState,
  type SmithersTaskManifestDocument,
  type SMITHERS_NODE_STATES,
  type SMITHERS_RUN_STATES,
  type SMITHERS_RUN_STATUSES
} from "@ultrafuzz/artifacts";
import {
  parseProjectConfigToml,
  parseResolvedConfigJsonBytes,
  resolveConfig,
  serializeResolvedConfigJsonBytes
} from "@ultrafuzz/config";
import {
  CACHE_MANIFEST_FILE,
  REFERENCE_CACHE_SCHEMA_VERSION,
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
  SMITHERS_BIN_PATH,
  SMITHERS_VERSION,
  smithersDependencyInstallArgs
} from "../src/smithers-package.js";
import { isTransientNpmRegistryFailure } from "../src/npm-install-retry.js";

import {
  forkRun as runtimeForkRun,
  cancelRun,
  commitControllerGeneration,
  getRunHealth,
  getRunStatus,
  initProject,
  listRuns,
  planRun,
  pauseRun,
  prepareControllerGeneration,
  readLinkedWorkflowEvidence,
  replayRun as runtimeReplayRun,
  resumeRun as runtimeResumeRun,
  startRun as runtimeStartRun,
  syncRun as runtimeSyncRun,
  toPlannedGraph,
  validateProject
} from "../src/index.js";
import { effectiveRouteEnvironment, modelDestination } from "../src/data-governance.js";
import {
  assertSmithersControllerRefreshable,
  inspectSmithersInstallation,
  refreshedSmithersControllerSnapshot,
  runSmithersInspectionCommand,
  runSmithersLifecycleCommand
} from "../src/smithers.js";
import { bindSmithersExecutableCapability } from "../src/smithers-executable-capability.js";
import { acquireWorkflowExecutionSnapshotAnchor } from "../src/workflow-execution-snapshot-capability.js";
import {
  acquireWorkflowControlLock,
  BUN_MODULE_CONFINEMENT_SOURCE,
  materializeWorkflowExecutionSnapshot,
  replaceBunStartupControlsForControllerRefresh,
  sealedBunStartupControlDrift
} from "../src/workflow-integrity.js";
import { linkedWorkflowExecutionEnvironment } from "../src/start-run.js";
import { verifyRequiredArtifactsForAttempt } from "../src/artifact-gates.js";
import { projectArtifactSchemaDir, projectArtifactSchemaJson } from "../src/init.js";
import { assertRenderedPromptValidatorCommands } from "../src/prompt-validator-command.js";
import { writeFakeNpmInstaller } from "./fake-npm-installer.js";
import { addOpenRouterProfile } from "./openrouter-profile-fixture.js";
import {
  shippedReferenceCatalog,
  writeShippedDocumentReferenceCaches,
  writeShippedVulnerabilityDatabaseCache
} from "./reference-fixtures.js";

const runningUnderBun = typeof process.versions.bun === "string";
const BUN_ADAPTER_TEST_PREFIX = "Bun adapter contract: ";
const bunAdapterTest = prefixTestNames(testWhen(runningUnderBun, { timeout: 30_000 }), BUN_ADAPTER_TEST_PREFIX);
const SMITHERS_TEST_ENVIRONMENT_ALLOWLIST = [
  "SMITHERS_FAKE_ADMISSION_TIMEOUT_LOG",
  "SMITHERS_FAKE_CLOUD_ENV_LOG",
  "SMITHERS_FAKE_CLOUD_SELECTOR_LOG",
  "SMITHERS_FAKE_CONTEXT_LOG",
  "SMITHERS_FAKE_DEEPSEEK_ENV_LOG",
  "SMITHERS_FAKE_ENV_LOG",
  "SMITHERS_FAKE_EXECUTED_AS_LOG",
  "SMITHERS_FAKE_FAIL_UP",
  "SMITHERS_FAKE_FORGE_GUARD_LOG",
  "SMITHERS_FAKE_FORKED_RUN_ID",
  "SMITHERS_FAKE_INPUT_LOG",
  "SMITHERS_FAKE_KEEP_WORKTREES_LOG",
  "SMITHERS_FAKE_KIMI_ENV_LOG",
  "SMITHERS_FAKE_LOG",
  "SMITHERS_FAKE_MARKER",
  "SMITHERS_FAKE_OPENROUTER_ENV_LOG",
  "SMITHERS_FAKE_PATH_LOG",
  "SMITHERS_FAKE_PAUSE_EMPTY_SUCCESS",
  "SMITHERS_FAKE_RETRY_CREDENTIAL_ENV_LOG",
  "SMITHERS_FAKE_RUN_EXISTS",
  "SMITHERS_FAKE_SNAPSHOT_ATTEMPT",
  "SMITHERS_FAKE_SNAPSHOT_BYTES_LOG"
] as const;
const OPENROUTER_TEST_STDERR_PENDING_LIMIT = 64 * 1024;
const TEST_DATA_GOVERNANCE_POLICY = `{"schema_version":"ultrafuzz.data-governance-policy.v1","sensitivity":"public","source_destinations":["cloud:modal","model:anthropic","model:deepseek","model:kimi-route-be5123592c4480e580fc02988f99efc0749a17f114dd67ec7ff655e87ae77a1f","model:moonshot","model:openai","model:openrouter"],"artifact_destinations":["cloud:modal"],"destination_policies":[{"destination":"cloud:modal","processor":"test","region":"local","retention_policy":"test","training_policy":"none","dpa_status":"n/a","minimization_policy":"synthetic","data_handling_basis":"public"},{"destination":"model:anthropic","processor":"test","region":"local","retention_policy":"test","training_policy":"none","dpa_status":"n/a","minimization_policy":"synthetic","data_handling_basis":"public"},{"destination":"model:deepseek","processor":"test","region":"local","retention_policy":"test","training_policy":"none","dpa_status":"n/a","minimization_policy":"synthetic","data_handling_basis":"public"},{"destination":"model:kimi-route-be5123592c4480e580fc02988f99efc0749a17f114dd67ec7ff655e87ae77a1f","processor":"test","region":"local","retention_policy":"test","training_policy":"none","dpa_status":"n/a","minimization_policy":"synthetic","data_handling_basis":"public"},{"destination":"model:moonshot","processor":"test","region":"local","retention_policy":"test","training_policy":"none","dpa_status":"n/a","minimization_policy":"synthetic","data_handling_basis":"public"},{"destination":"model:openai","processor":"test","region":"local","retention_policy":"test","training_policy":"none","dpa_status":"n/a","minimization_policy":"synthetic","data_handling_basis":"public"},{"destination":"model:openrouter","processor":"test","region":"local","retention_policy":"test","training_policy":"none","dpa_status":"n/a","minimization_policy":"synthetic","data_handling_basis":"public"}],"openrouter_model_allowlist":["~anthropic/claude-sonnet-latest:free","~vendor/model.latest:free+preview@2026"]}`;
process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-provider-homes-"));

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-"));
}

async function runSpawnedCommand(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs: number;
}): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs);
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.end(input.stdin);
  });
}

function prefixTestNames(register: typeof test, prefix: string): typeof test {
  return ((name: string, ...args: unknown[]) =>
    Reflect.apply(register, undefined, [`${prefix}${name}`, ...args])) as typeof test;
}

prefixTestNames(testWhen(false, { timeout: 30_000 }), BUN_ADAPTER_TEST_PREFIX)(
  "conditional registration keeps unavailable contracts skipped",
  () => assert.fail("testWhen(false) must register this contract through test.skip")
);

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
  const packageRoot = path.join(project, ".fake-ultrafuzz-cli");
  const entrypoint = path.join(packageRoot, "dist", "index.mjs");
  if (fs.existsSync(entrypoint)) return entrypoint;
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "fake-ultrafuzz-cli", version: "1.0.0", type: "module" })}\n`,
    "utf8"
  );
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
  const environmentAllowlist = [
    ...SMITHERS_TEST_ENVIRONMENT_ALLOWLIST,
    ...(input.env?.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? "").split(",")
  ]
    .map((name) => name.trim())
    .filter((name, index, names) => name.length > 0 && names.indexOf(name) === index)
    .join(",");
  const ambientRouteEnvironment = Object.fromEntries(
    ["ClaudeAgent", "CodexAgent", "KimiAgent"]
      .flatMap((agent) => effectiveRouteEnvironment(agent, process.env).map(([name]) => name))
      .map((name) => [name, undefined])
  );
  return runtimeStartRun(
    withFakeCliEntrypoint({
      ...input,
      env: {
        ...ambientRouteEnvironment,
        ULTRAFUZZ_DATA_GOVERNANCE_POLICY: TEST_DATA_GOVERNANCE_POLICY,
        ULTRAFUZZ_PROVIDER_HOME_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), "ufz-start-provider-homes-")),
        ALL_PROXY: undefined,
        HTTP_PROXY: undefined,
        HTTPS_PROXY: undefined,
        NO_PROXY: undefined,
        all_proxy: undefined,
        http_proxy: undefined,
        https_proxy: undefined,
        no_proxy: undefined,
        OPENAI_BASE_URL: undefined,
        KIMI_BASE_URL: undefined,
        ...input.env,
        ULTRAFUZZ_AGENT_ENV_ALLOWLIST: environmentAllowlist
      }
    })
  );
}

const testPricingCatalogs = new Map<string, string>();
let testPricingCatalogSequence = 0;

const testPricingFetch: typeof fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  const catalog = testPricingCatalogs.get(url);
  if (catalog === undefined) throw new Error(`unexpected pricing catalog URL in test: ${url}`);
  return new Response(catalog, { headers: { "content-type": "application/json" } });
};

function syncRun(
  input: Parameters<typeof runtimeSyncRun>[0],
  control: NonNullable<Parameters<typeof runtimeSyncRun>[1]> = {}
): ReturnType<typeof runtimeSyncRun> {
  return runtimeSyncRun(input, {
    ...control,
    pricingFetch: testPricingFetch,
    pricingLookupHostname: async () => [{ address: "93.184.216.34", family: 4 }]
  });
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
    .replace('from "./environment"', 'from "./environment.mjs"')
    .replace('from "./provider-home"', 'from "./provider-home.mjs"');
  fs.writeFileSync(path.join(fixture, "kimi.mjs"), transpile(kimiSource), "utf8");
  fs.writeFileSync(
    path.join(fixture, "environment.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "environment.ts"), "utf8")),
    "utf8"
  );
  fs.writeFileSync(
    path.join(fixture, "provider-home.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "provider-home.ts"), "utf8")),
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
  fs.copyFileSync(path.join(fixture, "strict-json.mjs"), path.join(fixture, "strict-json"));
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
    source?: Record<string, string | undefined>,
    route?: { agent: "ClaudeAgent" | "CodexAgent" | "KimiAgent"; configDir?: string }
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
    .replace('from "./environment"', 'from "./environment.mjs"')
    .replace('from "./provider-home"', 'from "./provider-home.mjs"');
  fs.writeFileSync(path.join(fixture, "codex.mjs"), transpile(codexSource), "utf8");
  fs.writeFileSync(
    path.join(fixture, "environment.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "environment.ts"), "utf8")),
    "utf8"
  );
  fs.writeFileSync(
    path.join(fixture, "provider-home.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "provider-home.ts"), "utf8")),
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
  fs.copyFileSync(path.join(fixture, "strict-json.mjs"), path.join(fixture, "strict-json"));
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
      source?: Record<string, string | undefined>,
      route?: { agent: "ClaudeAgent" | "CodexAgent" | "KimiAgent"; configDir?: string }
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
    createOutputInterpreter(): {
      onStdoutLine?: (
        line: string
      ) => { type?: string; answer?: string } | Array<{ type?: string; answer?: string }> | null | undefined;
    };
    buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
      command: string;
      args: string[];
      stdin?: string;
      env?: Record<string, string>;
      outputFormat?: string;
    }>;
  };
}> {
  const fixture = path.join(project, "pi-agent-executable-test");
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
  const piSource = fs
    .readFileSync(path.join(agentsDir, "pi.ts"), "utf8")
    .replace('from "smthrs"', `from ${JSON.stringify(smithersUrl)}`)
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
  fs.writeFileSync(
    path.join(fixture, "strict-json.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "strict-json.ts"), "utf8")),
    "utf8"
  );
  fs.copyFileSync(path.join(fixture, "strict-json.mjs"), path.join(fixture, "strict-json"));
  const piModule = (await import(pathToFileURL(path.join(fixture, "pi.mjs")).href)) as {
    createPiAgent(options?: Record<string, unknown>): {
      opts: { env: Record<string, string>; sessionDir?: string; apiKey?: string };
      createOutputInterpreter(): {
        onStdoutLine?: (
          line: string
        ) => { type?: string; answer?: string } | Array<{ type?: string; answer?: string }> | null | undefined;
      };
      buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
        command: string;
        args: string[];
        stdin?: string;
        env?: Record<string, string>;
        outputFormat?: string;
      }>;
    };
  };
  return { createPiAgent: piModule.createPiAgent };
}

async function loadGeneratedOpenCodeAgent(project: string): Promise<{
  createOpenCodeAgent(options?: Record<string, unknown>): {
    opts: { env: Record<string, string> };
    buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
      command: string;
      args: string[];
      env?: Record<string, string>;
    }>;
  };
}> {
  const fixture = path.join(project, "opencode-agent-executable-test");
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
  const openCodeSource = fs
    .readFileSync(path.join(agentsDir, "opencode.ts"), "utf8")
    .replace('from "smthrs"', `from ${JSON.stringify(smithersUrl)}`)
    .replace('from "./toml"', 'from "./toml.mjs"')
    .replace('from "./environment"', 'from "./environment.mjs"');
  fs.writeFileSync(path.join(fixture, "opencode.mjs"), transpile(openCodeSource), "utf8");
  for (const name of ["environment", "toml", "strict-json"] as const) {
    fs.writeFileSync(
      path.join(fixture, `${name}.mjs`),
      transpile(fs.readFileSync(path.join(agentsDir, `${name}.ts`), "utf8")),
      "utf8"
    );
  }
  fs.copyFileSync(path.join(fixture, "strict-json.mjs"), path.join(fixture, "strict-json"));
  return (await import(pathToFileURL(path.join(fixture, "opencode.mjs")).href)) as {
    createOpenCodeAgent(options?: Record<string, unknown>): {
      opts: { env: Record<string, string> };
      buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
        command: string;
        args: string[];
        env?: Record<string, string>;
      }>;
    };
  };
}

async function loadGeneratedOpenRouterAgent(
  project: string,
  retryPolicy?: {
    retryWindowMs: number;
    initialDelayMs: number;
    maxDelayMs: number;
    jitterFraction: number;
    provisionalCallbackLimit?: number;
    actionSnapshotLimit?: number;
    actionSnapshotBytes?: number;
  },
  testInstrumentation?: {
    acknowledgeProvisionalRateLimit?: boolean;
    expireRetryDeadlineBeforeReplacementBuild?: number;
  }
): Promise<{
  OpenRouterCodexAgent: new (options?: Record<string, unknown>) => {
    generate(options?: Record<string, unknown>): Promise<{ text: string }>;
    buildCommand: (params: {
      prompt: string;
      cwd: string;
      options: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>;
  };
  decideOpenRouter429Recovery(input: {
    retryAttempt: number;
    nowMs: number;
    retryDeadlineMs: number;
    totalDeadlineMs?: number;
    random: number;
  }):
    | { kind: "rate-limit-exhausted" }
    | { kind: "total-timeout" }
    | { kind: "backoff"; delayMs: number; afterDelay: "retry" | "total-timeout" };
  createOpenRouterAgent(options?: Record<string, unknown>): {
    opts: Record<string, unknown> & { env?: Record<string, string> };
    generate(options?: {
      prompt?: unknown;
      onEvent?: (event: Record<string, unknown>) => unknown;
      onStderr?: (text: string) => void;
      abortSignal?: AbortSignal;
      [key: string]: unknown;
    }): Promise<{ text: string }>;
    stream(options?: {
      prompt?: unknown;
      onEvent?: (event: Record<string, unknown>) => unknown;
      onStderr?: (text: string) => void;
      abortSignal?: AbortSignal;
      [key: string]: unknown;
    }): Promise<{ text: Promise<string>; textStream: ReadableStream<string> & AsyncIterable<string> }>;
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
    .replace('from "./environment"', 'from "./environment.mjs"')
    .replace('from "./provider-home"', 'from "./provider-home.mjs"');
  let openRouterSource = fs
    .readFileSync(path.join(agentsDir, "openrouter.ts"), "utf8")
    .replace('from "smthrs"', `from ${JSON.stringify(smithersUrl)}`)
    .replace('from "./codex"', 'from "./codex.mjs"')
    .replace('from "./toml"', 'from "./toml.mjs"')
    .replace('from "./environment"', 'from "./environment.mjs"')
    .replace('from "./provider-home"', 'from "./provider-home.mjs"');
  if (retryPolicy !== undefined) {
    for (const [from, to] of [
      [
        "const OPENROUTER_429_RECOVERY_WINDOW_MS = 120_000;",
        `const OPENROUTER_429_RECOVERY_WINDOW_MS = ${retryPolicy.retryWindowMs};`
      ],
      [
        "const OPENROUTER_429_INITIAL_DELAY_MS = 1_000;",
        `const OPENROUTER_429_INITIAL_DELAY_MS = ${retryPolicy.initialDelayMs};`
      ],
      ["const OPENROUTER_429_MAX_DELAY_MS = 30_000;", `const OPENROUTER_429_MAX_DELAY_MS = ${retryPolicy.maxDelayMs};`],
      [
        "const OPENROUTER_429_JITTER_FRACTION = 0.25;",
        `const OPENROUTER_429_JITTER_FRACTION = ${retryPolicy.jitterFraction};`
      ]
    ] as const) {
      const replaced = openRouterSource.replace(from, to);
      assert.notEqual(replaced, openRouterSource, `missing generated OpenRouter retry policy source: ${from}`);
      openRouterSource = replaced;
    }
    if (retryPolicy.provisionalCallbackLimit !== undefined) {
      const from = "const OPENROUTER_PROVISIONAL_CALLBACK_LIMIT = 256;";
      const replaced = openRouterSource.replace(
        from,
        `const OPENROUTER_PROVISIONAL_CALLBACK_LIMIT = ${retryPolicy.provisionalCallbackLimit};`
      );
      assert.notEqual(replaced, openRouterSource, `missing generated OpenRouter source: ${from}`);
      openRouterSource = replaced;
    }
    for (const [from, value] of [
      ["const OPENROUTER_ACTION_SNAPSHOT_LIMIT = 256;", retryPolicy.actionSnapshotLimit],
      ["const OPENROUTER_ACTION_SNAPSHOT_BYTES = 256 * 1024;", retryPolicy.actionSnapshotBytes]
    ] as const) {
      if (value === undefined) continue;
      const replaced = openRouterSource.replace(from, from.replace(/= .*;/u, `= ${value};`));
      assert.notEqual(replaced, openRouterSource, `missing generated OpenRouter source: ${from}`);
      openRouterSource = replaced;
    }
  }
  if (testInstrumentation?.acknowledgeProvisionalRateLimit === true) {
    const from = 'this.#provisionalRateLimit = matchState === "provisional";';
    const replaced = openRouterSource.replace(
      from,
      `${from}
    if (
      this.#provisionalRateLimit &&
      process.env.OPENROUTER_RETRY_FIXTURE_MODE === "stderr-provisional-post-terminal"
    ) {
      const acknowledgementPath = process.env.OPENROUTER_RETRY_FIXTURE_PROVISIONAL_ACK;
      if (acknowledgementPath !== undefined) writeFileSync(acknowledgementPath, "observed\\n", "utf8");
    }`
    );
    assert.notEqual(replaced, openRouterSource, "missing generated OpenRouter provisional transition source");
    openRouterSource = replaced;
  }
  const expirationBuild = testInstrumentation?.expireRetryDeadlineBeforeReplacementBuild;
  if (expirationBuild !== undefined) {
    assert.equal(
      Number.isSafeInteger(expirationBuild) && expirationBuild > 0,
      true,
      "generated OpenRouter deadline expiration build must be a positive integer"
    );
    const counterFrom = 'const OPENROUTER_ATTEMPT_DEADLINES = Symbol("ultrafuzz.openrouter.attempt-deadlines");';
    const counterReplacement = `${counterFrom}\nlet openRouterTestReplacementBuildCount = 0;`;
    let replaced = openRouterSource.replace(counterFrom, counterReplacement);
    assert.notEqual(replaced, openRouterSource, "missing generated OpenRouter attempt-deadline source");
    openRouterSource = replaced;

    const deadlineFrom = "    const deadlineError = openRouterAttemptDeadlineError(params.options);";
    replaced = openRouterSource.replace(
      deadlineFrom,
      `    const instrumentedAttemptDeadlines = (params.options as Record<PropertyKey, unknown>)[
      OPENROUTER_ATTEMPT_DEADLINES
    ] as OpenRouterAttemptDeadlines | undefined;
    if (
      instrumentedAttemptDeadlines?.retryDeadlineMs !== undefined &&
      ++openRouterTestReplacementBuildCount >= ${expirationBuild}
    ) {
      instrumentedAttemptDeadlines.retryDeadlineMs = performance.now() - 1;
    }
${deadlineFrom}`
    );
    assert.notEqual(replaced, openRouterSource, "missing generated OpenRouter build deadline source");
    openRouterSource = replaced;
  }
  fs.writeFileSync(path.join(fixture, "codex.mjs"), transpile(codexSource), "utf8");
  fs.writeFileSync(path.join(fixture, "openrouter.mjs"), transpile(openRouterSource), "utf8");
  fs.writeFileSync(
    path.join(fixture, "environment.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "environment.ts"), "utf8")),
    "utf8"
  );
  fs.writeFileSync(
    path.join(fixture, "provider-home.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "provider-home.ts"), "utf8")),
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
  fs.copyFileSync(path.join(fixture, "strict-json.mjs"), path.join(fixture, "strict-json"));
  return (await import(pathToFileURL(path.join(fixture, "openrouter.mjs")).href)) as {
    OpenRouterCodexAgent: new (options?: Record<string, unknown>) => {
      generate(options?: Record<string, unknown>): Promise<{ text: string }>;
      buildCommand: (params: {
        prompt: string;
        cwd: string;
        options: Record<string, unknown>;
      }) => Promise<Record<string, unknown>>;
    };
    decideOpenRouter429Recovery(input: {
      retryAttempt: number;
      nowMs: number;
      retryDeadlineMs: number;
      totalDeadlineMs?: number;
      random: number;
    }):
      | { kind: "rate-limit-exhausted" }
      | { kind: "total-timeout" }
      | { kind: "backoff"; delayMs: number; afterDelay: "retry" | "total-timeout" };
    createOpenRouterAgent(options?: Record<string, unknown>): {
      opts: Record<string, unknown> & { env?: Record<string, string> };
      generate(options?: {
        prompt?: unknown;
        onEvent?: (event: Record<string, unknown>) => unknown;
        onStdout?: (text: string) => void;
        onStderr?: (text: string) => void;
        onProcess?: (event: { phase: "started" | "exited"; pid: number | undefined }) => void;
        abortSignal?: AbortSignal;
        [key: string]: unknown;
      }): Promise<{ text: string }>;
      stream(options?: {
        prompt?: unknown;
        onEvent?: (event: Record<string, unknown>) => unknown;
        onStdout?: (text: string) => void;
        onStderr?: (text: string) => void;
        onProcess?: (event: { phase: "started" | "exited"; pid: number | undefined }) => void;
        abortSignal?: AbortSignal;
        [key: string]: unknown;
      }): Promise<{ text: Promise<string>; textStream: ReadableStream<string> & AsyncIterable<string> }>;
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

function installOpenRouterRetryCodexFixture(project: string): {
  bin: string;
  counter: string;
  journal: string;
  sentinel: string;
  provisionalAck: string;
  warningAck: string;
} {
  const bin = path.join(project, "openrouter-retry-bin");
  const counter = path.join(project, "openrouter-retry-count");
  const journal = path.join(project, "openrouter-retry-journal.jsonl");
  const sentinel = path.join(project, "openrouter-retry-sentinel");
  const provisionalAck = path.join(project, "openrouter-retry-provisional-ack");
  const warningAck = path.join(project, "openrouter-retry-warning-ack");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(counter, "0", "utf8");
  fs.writeFileSync(journal, "", "utf8");
  const executable = path.join(bin, "codex");
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.147.0\\n");
  process.exit(0);
}
const counterPath = process.env.OPENROUTER_RETRY_FIXTURE_COUNTER;
const journalPath = process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL;
const sentinelPath = process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL;
const provisionalAckPath = process.env.OPENROUTER_RETRY_FIXTURE_PROVISIONAL_ACK;
const warningAckPath = process.env.OPENROUTER_RETRY_FIXTURE_WARNING_ACK;
let count = 0;
try { count = Number(fs.readFileSync(counterPath, "utf8")); } catch {}
count += 1;
fs.writeFileSync(counterPath, String(count), "utf8");
const failureCount = Number(process.env.OPENROUTER_RETRY_FIXTURE_FAILURES ?? "1");
const mode = process.env.OPENROUTER_RETRY_FIXTURE_MODE ?? "initial";
const argv = process.argv.slice(2);
const resumed = argv[0] === "exec" && argv[1] === "resume";
const resumeSession = resumed ? argv.at(-2) : undefined;
let stdin = "";
process.stdin.resume();
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const substantiveMode = mode.startsWith("substantive-") ||
    [
      "missing-session",
      "conflicting-session",
      "fresh-conflicting-session",
      "late-conflicting-session",
      "stderr-only",
      "resume-hang",
      "terminal-null-resume",
      "terminal-null-no-session",
      "terminal-null-repeat",
      "terminal-null-late-callback"
    ].includes(mode);
  if (substantiveMode && !resumed) fs.appendFileSync(sentinelPath, "mutation\\n", "utf8");
  fs.appendFileSync(journalPath, JSON.stringify({
    count,
    argv,
    stdin,
    invocation: resumed ? "resume" : "fresh",
    resumeSession,
    sentinel: fs.existsSync(sentinelPath) ? fs.readFileSync(sentinelPath, "utf8") : ""
  }) + "\\n", "utf8");
  const sessionId = mode === "conflicting-session" && resumed
    ? "conflicting-session"
    : mode === "initial"
      ? "fixture-" + count
      : "fixture-session";
  if (!((mode === "missing-session" || mode === "terminal-null-no-session") && count === 1)) {
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: sessionId }) + "\\n");
  }
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
  if (mode.startsWith("terminal-null-")) {
    const outputIndex = process.argv.indexOf("--output-last-message");
    if (mode === "terminal-null-late-callback") {
      process.stdout.write(JSON.stringify({
        type: "item.started",
        item: { id: "unfinished-reasoning", type: "reasoning", text: "substantive work without a final" }
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 2, output_tokens: 1 }
      }) + "\\n");
      return;
    }
    if (!resumed || mode === "terminal-null-repeat") {
      const commentary = "I will inspect the task before I finish it.";
      if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], commentary, "utf8");
      process.stdout.write(JSON.stringify({
        type: "item.completed",
        item: { id: "premature-commentary", type: "agent_message", text: commentary }
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "item.started",
        item: { id: "unfinished-reasoning", type: "reasoning", text: "substantive work without a final" }
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 2, output_tokens: 1 }
      }) + "\\n");
      return;
    }
    if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], "DONE", "utf8");
    process.stdout.write(JSON.stringify({
      type: "item.completed",
      item: { id: "terminal-answer", type: "agent_message", text: "DONE" }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 2, output_tokens: 1 }
    }) + "\\n");
    return;
  }
  if (mode === "callback-hang") {
    setTimeout(() => process.exit(0), 600);
    return;
  }
  if (mode === "stdout-callback-hang") {
    // BaseCliAgent's onStdout contract carries extracted assistant text rather
    // than raw Codex JSONL. Emit a recognized streaming-text envelope so this
    // fixture exercises a live onStdout callback before the child exits.
    process.stdout.write(JSON.stringify({
      type: "message",
      role: "assistant",
      content: "live stdout before hang"
    }) + "\\n");
    setTimeout(() => process.exit(0), 600);
    return;
  }
  if (mode === "stderr-callback-hang") {
    process.stderr.write("live stderr before hang");
    setTimeout(() => process.exit(0), 600);
    return;
  }
  if (mode === "stderr-429-hang" && count <= failureCount) {
    process.stderr.write("HTTP 429 request id: fixture-" + count + "\\n");
    setInterval(() => {}, 1_000);
    return;
  }
  if (mode === "substantive-replay" && resumed) {
    process.stdout.write(JSON.stringify({
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: "fixture progress" }
    }) + "\\n");
  }
  if (mode === "substantive-snapshot-overflow" && resumed) {
    for (const snapshot of [1, 4]) {
      process.stdout.write(JSON.stringify({
        type: "item.completed",
        item: { id: "snapshot-" + snapshot, type: "agent_message", text: "snapshot " + snapshot }
      }) + "\\n");
    }
  }
  if (mode === "late-conflicting-session" && resumed) {
    process.stdout.write(JSON.stringify({
      type: "item.completed",
      item: { id: "late-before-conflict", type: "agent_message", text: "before conflict" }
    }) + "\\n");
    process.stdout.write(
      JSON.stringify({ type: "thread.started", thread_id: "conflicting-session" }) +
        "\\n" +
        JSON.stringify({ type: "message", role: "assistant", content: "must stay quarantined" }) +
        "\\n"
    );
    setTimeout(() => {
      fs.appendFileSync(sentinelPath, "wrong-session-mutation\\n", "utf8");
      process.stdout.write(JSON.stringify({
        type: "item.completed",
        item: { id: "post-conflict", type: "agent_message", text: "must stay quarantined" }
      }) + "\\n");
      process.stderr.write("wrong-session-stderr must stay quarantined\\n");
      const outputIndex = process.argv.indexOf("--output-last-message");
      if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], "WRONG", "utf8");
      process.stdout.write(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 2, output_tokens: 1 }
      }) + "\\n");
    }, 100);
    return;
  }
  if (mode === "resume-hang" && resumed) {
    process.stdout.write(JSON.stringify({
      type: "item.completed",
      item: { id: "resume-message", type: "agent_message", text: "resume began" }
    }) + "\\n");
    setInterval(() => {}, 1_000);
    return;
  }
  if (mode === "substantive-updates" && resumed) {
    process.stdout.write(JSON.stringify({
      type: "item.updated",
      item: { id: "update-1", type: "command_execution", command: "fixture-update", status: "in_progress" }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "item.updated",
      item: { id: "update-1", type: "command_execution", command: "fixture-update", status: "completed" }
    }) + "\\n");
  }
  if (mode === "warning-burst") {
    for (let warning = 0; warning < 256; warning += 1) {
      process.stderr.write("ordinary warning " + warning + "\\n");
    }
    // stdout and stderr use separate pipes. Wait for an explicit parent
    // acknowledgement so success cannot overtake the warning burst.
    const warningAckDeadline = setTimeout(() => {
      clearInterval(warningAckTimer);
      process.stderr.write("warning-burst acknowledgement timed out\\n");
      process.exitCode = 1;
    }, 5_000);
    const warningAckTimer = setInterval(() => {
      if (!fs.existsSync(warningAckPath)) return;
      clearInterval(warningAckTimer);
      clearTimeout(warningAckDeadline);
      const outputIndex = process.argv.indexOf("--output-last-message");
      if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], "OK", "utf8");
      process.stdout.write(JSON.stringify({
        type: "item.completed",
        item: { id: "final-message", type: "agent_message", text: "OK" }
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 2, output_tokens: 1 }
      }) + "\\n");
    }, 1);
    return;
  }
  if (
    mode === "stderr-left-boundary-negative" ||
    mode === "stderr-right-boundary-negative" ||
    mode === "stderr-long-s-boundary-negative"
  ) {
    const first =
      mode === "stderr-left-boundary-negative"
        ? "prefix"
        : mode === "stderr-long-s-boundary-negative"
          ? "HTTP ſtatus 429"
          : "HTTP 429";
    const second = mode === "stderr-left-boundary-negative" ? "HTTP 429 suffix\\n" : "suffix\\n";
    process.stderr.write(first);
    setTimeout(() => {
      if (mode === "stderr-right-boundary-negative" || mode === "stderr-long-s-boundary-negative") {
        process.stdout.write(JSON.stringify({
          type: "message",
          role: "assistant",
          content: mode + " boundary disproved"
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "item.completed",
          item: { id: "provisional-safe", type: "agent_message", text: mode + " event preserved" }
        }) + "\\n");
      }
      process.stderr.write(second);
      const outputIndex = process.argv.indexOf("--output-last-message");
      if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], "OK", "utf8");
      process.stdout.write(JSON.stringify({
        type: "item.completed",
        item: { id: "final-message", type: "agent_message", text: "OK" }
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 2, output_tokens: 1 }
      }) + "\\n");
    }, 10);
    return;
  }
  if (count <= failureCount && mode !== "empty-success" && mode !== "warning-burst") {
    const rateLimitMessage =
      "exceeded retry limit, last status: 429 Too Many Requests, request id: fixture-" + count;
    if (mode === "stderr-provisional-post-terminal") {
      // The test-generated relay acknowledges only after its actual
      // provisional transition, regardless of how this write is chunked.
      process.stderr.write("provisional boundary ready\\nHTTP 429");
      const provisionalAckDeadline = setTimeout(() => {
        clearInterval(provisionalAckTimer);
        process.stderr.write("\\nprovisional boundary acknowledgement timed out\\n");
        process.exitCode = 1;
      }, 5_000);
      const provisionalAckTimer = setInterval(() => {
        if (!provisionalAckPath || !fs.existsSync(provisionalAckPath)) return;
        clearInterval(provisionalAckTimer);
        clearTimeout(provisionalAckDeadline);
        fs.appendFileSync(sentinelPath, "provisional-post-terminal-mutation\\n", "utf8");
        process.stdout.write(JSON.stringify({
          type: "message",
          role: "assistant",
          content: "provisional post-terminal stdout must stay quarantined"
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "item.started",
          item: {
            id: "provisional-post-terminal",
            type: "command_execution",
            command: "provisional post-terminal event must stay quarantined",
            status: "in_progress"
          }
        }) + "\\n");
        process.stderr.write("\\n");
        process.exitCode = 1;
      }, 1);
      return;
    }
    if (mode === "stderr-post-terminal" || mode === "stdout-post-terminal") {
      if (mode === "stderr-post-terminal") {
        process.stderr.write(rateLimitMessage + "\\n");
      } else {
        process.stdout.write(JSON.stringify({ type: "error", message: rateLimitMessage }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: rateLimitMessage } }) + "\\n");
      }
      setTimeout(() => {
        fs.appendFileSync(sentinelPath, "post-terminal-observed-mutation\\n", "utf8");
        process.stdout.write(JSON.stringify({
          type: "message",
          role: "assistant",
          content: "post-terminal stdout must stay quarantined"
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "item.started",
          item: {
            id: "post-terminal",
            type: "command_execution",
            command: "post-terminal event must stay quarantined",
            status: "in_progress"
          }
        }) + "\\n");
        process.stderr.write("post-terminal stderr warning must stay quarantined\\n");
        process.exitCode = 1;
      }, 20);
      return;
    }
    if (mode === "stderr-oversized") {
      process.stderr.write(
        "429 Too Many Requests request id: fixture-" + count + " " + "x".repeat(70 * 1024)
      );
      process.exitCode = 1;
      return;
    }
    if (mode === "stderr-character-split") {
      const splitMessage = "HTTP\\n429 Too Many Requests request id: fixture-" + count;
      let splitIndex = 0;
      const splitTimer = setInterval(() => {
        process.stderr.write(splitMessage[splitIndex] ?? "");
        splitIndex += 1;
        if (splitIndex >= splitMessage.length) {
          clearInterval(splitTimer);
          process.exitCode = 1;
        }
      }, 1);
      return;
    }
    if (mode === "stderr-unicode-prefix-split") {
      process.stderr.write("İ\\nH");
      setTimeout(() => {
        process.stderr.write("TTP 429 request id: fixture-" + count + "\\n");
        process.exitCode = 1;
      }, 10);
      return;
    }
    if (mode === "structured-429-partial-stderr") {
      process.stderr.write("HTT");
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "error", message: rateLimitMessage }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: rateLimitMessage } }) + "\\n");
        process.exitCode = 1;
      }, 10);
      return;
    }
    const substantiveEvents = {
      "substantive-command": {
        type: "item.started",
        item: { id: "command-1", type: "command_execution", command: "fixture-command", status: "in_progress" }
      },
      "substantive-message": {
        type: "item.completed",
        item: { id: "message-1", type: "agent_message", text: "fixture model output" }
      },
      "substantive-reasoning": {
        type: "item.started",
        item: { id: "reasoning-1", type: "reasoning", text: "fixture reasoning" }
      },
      "substantive-file": {
        type: "item.completed",
        item: { id: "file-1", type: "file_change", changes: [{ path: "fixture.txt", kind: "update" }] }
      },
      "substantive-tool": {
        type: "item.started",
        item: { id: "tool-1", type: "mcp_tool_call", server: "fixture", tool: "probe", status: "in_progress" }
      },
      "substantive-web": {
        type: "item.completed",
        item: { id: "web-1", type: "web_search", query: "fixture query" }
      },
      "substantive-todo": {
        type: "item.started",
        item: { id: "todo-1", type: "todo_list", items: [{ text: "fixture task", completed: false }] }
      },
      "substantive-429-message": {
        type: "item.completed",
        item: { id: "message-429", type: "agent_message", text: "Investigated HTTP 429 handling" }
      }
    };
    if (mode === "substantive-updates" && count === 1) {
      process.stdout.write(JSON.stringify({
        type: "item.updated",
        item: { id: "update-1", type: "command_execution", command: "fixture-update", status: "in_progress" }
      }) + "\\n");
    }
    if ((mode === "substantive-stdout-only" && count === 1) || mode === "substantive-stdout-replay") {
      process.stdout.write(JSON.stringify({
        type: "message",
        role: "assistant",
        content: mode === "substantive-stdout-replay" ? "replayed stdout progress" : "stdout-only substantive progress"
      }) + "\\n");
    }
    if (mode === "substantive-stdout-oversized-replay") {
      process.stdout.write(JSON.stringify({
        type: "message",
        role: "assistant",
        content: "oversized-replay-" + "x".repeat(1_024)
      }) + "\\n");
    }
    if (mode === "substantive-action-oversized-replay") {
      process.stdout.write(JSON.stringify({
        type: "item.completed",
        item: { id: "oversized-action", type: "agent_message", text: "x".repeat(1_024) }
      }) + "\\n");
    }
    if (mode === "substantive-snapshot-overflow" && count === 1) {
      for (const snapshot of [1, 2, 3, 4]) {
        process.stdout.write(JSON.stringify({
          type: "item.completed",
          item: { id: "snapshot-" + snapshot, type: "agent_message", text: "snapshot " + snapshot }
        }) + "\\n");
      }
    }
    const substantiveEvent = count === 1
      ? substantiveEvents[mode] ?? (substantiveMode && mode !== "substantive-updates" && mode !== "substantive-snapshot-overflow" && mode !== "substantive-stdout-only" && mode !== "substantive-stdout-replay" && mode !== "substantive-stdout-oversized-replay" && mode !== "substantive-action-oversized-replay"
        ? { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "fixture progress" } }
        : undefined)
      : undefined;
    if (substantiveEvent) process.stdout.write(JSON.stringify(substantiveEvent) + "\\n");
    if (mode === "fresh-conflicting-session" && count === 1) {
      process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "conflicting-session" }) + "\\n");
    }
    const message = mode === "unrelated"
      ? "fixture path /tmp/job-429 is unavailable"
      : rateLimitMessage;
    if (mode === "stderr-only") {
      const splitAt = Math.max(1, message.indexOf("429") + 2);
      process.stderr.write(message.slice(0, splitAt));
      setTimeout(() => {
        process.stderr.write(message.slice(splitAt) + "\\n");
        process.exitCode = 1;
      }, 10);
      return;
    }
    process.stdout.write(JSON.stringify({ type: "error", message }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message } }) + "\\n");
    process.exitCode = 1;
    return;
  }
  const outputIndex = process.argv.indexOf("--output-last-message");
  if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], "OK", "utf8");
  if (mode !== "empty-success") {
    process.stdout.write(JSON.stringify({
      type: "item.completed",
      item: { id: "final-message", type: "agent_message", text: "OK" }
    }) + "\\n");
  }
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 2, output_tokens: 1 }
  }) + "\\n");
});
`,
    { encoding: "utf8", mode: 0o755 }
  );
  return { bin, counter, journal, sentinel, provisionalAck, warningAck };
}

type OpenRouterRetryFixtureEntry = {
  count: number;
  argv: string[];
  stdin: string;
  invocation: "fresh" | "resume";
  resumeSession?: string;
  sentinel: string;
};

function readOpenRouterRetryFixtureJournal(pathname: string): OpenRouterRetryFixtureEntry[] {
  const text = fs.readFileSync(pathname, "utf8").trim();
  return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line) as OpenRouterRetryFixtureEntry);
}

async function loadGeneratedDeepSeekAgent(project: string): Promise<{
  createDeepSeekAgent(options?: Record<string, unknown>): {
    buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
      env?: Record<string, string>;
    }>;
  };
  CompatibleClaudeCodeAgent: new (options: Record<string, unknown>) => {
    buildCommand(params: {
      prompt: string;
      cwd: string;
      options: Record<string, unknown>;
    }): Promise<{ args: string[] }>;
  };
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
      cleanup?: () => void | Promise<void>;
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
    .replace('from "./environment"', 'from "./environment.mjs"')
    .replace('from "./provider-home"', 'from "./provider-home.mjs"');
  fs.writeFileSync(path.join(fixture, "deepseek.mjs"), transpile(deepSeekSource), "utf8");
  const claudeSource = fs
    .readFileSync(path.join(agentsDir, "claude.ts"), "utf8")
    .replace('from "smthrs"', `from ${JSON.stringify(smithersUrl)}`)
    .replace('from "./toml"', 'from "./toml.mjs"')
    .replace('from "./environment"', 'from "./environment.mjs"')
    .replace('from "./provider-home"', 'from "./provider-home.mjs"');
  fs.writeFileSync(path.join(fixture, "claude.mjs"), transpile(claudeSource), "utf8");
  fs.writeFileSync(
    path.join(fixture, "environment.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "environment.ts"), "utf8")),
    "utf8"
  );
  fs.writeFileSync(
    path.join(fixture, "provider-home.mjs"),
    transpile(fs.readFileSync(path.join(agentsDir, "provider-home.ts"), "utf8")),
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
  fs.copyFileSync(path.join(fixture, "strict-json.mjs"), path.join(fixture, "strict-json"));
  const deepSeekModule = (await import(pathToFileURL(path.join(fixture, "deepseek.mjs")).href)) as {
    createDeepSeekAgent(options?: Record<string, unknown>): {
      buildCommand(params: { prompt: string; cwd: string; options: Record<string, unknown> }): Promise<{
        env?: Record<string, string>;
      }>;
    };
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
        cleanup?: () => void | Promise<void>;
      }>;
      createOutputInterpreter(): {
        onStdoutLine?: (line: string) => unknown;
        onExit?: (result: unknown) => unknown;
      };
    };
  };
  const claudeModule = (await import(pathToFileURL(path.join(fixture, "claude.mjs")).href)) as {
    CompatibleClaudeCodeAgent: new (options: Record<string, unknown>) => {
      buildCommand(params: {
        prompt: string;
        cwd: string;
        options: Record<string, unknown>;
      }): Promise<{ args: string[] }>;
    };
  };
  return {
    createDeepSeekAgent: deepSeekModule.createDeepSeekAgent,
    CompatibleClaudeCodeAgent: claudeModule.CompatibleClaudeCodeAgent,
    DeepSeekClaudeCodeAgent: deepSeekModule.DeepSeekClaudeCodeAgent
  };
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

function fakeSmithersEnv(project: string): Record<string, string | undefined> {
  const binDir = path.join(path.dirname(project), `${path.basename(project)}-fake-bin`);
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  const commandLog = path.join(project, "smithers-commands.log");
  const statusOverride = path.join(project, "fake-smithers-status-override.json");
  const alreadyPausedMarker = path.join(project, "fake-smithers-already-paused");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellQuote(commandLog)}`,
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
      '  printf \'%s|%s|%s|%s|%s|%s\\n\' "$OPENAI_API_KEY" "$AWS_SECRET_ACCESS_KEY" "$FOUNDRY_PROFILE" "$CLAUDE_CONFIG_DIR" "$SMITHERS_UNDOCUMENTED_SECRET" "$ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES" > "$SMITHERS_FAKE_ENV_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_CLOUD_ENV_LOG" ]; then',
      '  printf \'%s|%s\\n\' "$MODAL_TOKEN_ID" "$MODAL_TOKEN_SECRET" > "$SMITHERS_FAKE_CLOUD_ENV_LOG"',
      "fi",
      'if [ -n "$SMITHERS_FAKE_KIMI_ENV_LOG" ]; then',
      '  printf \'%s|%s|%s|%s|%s|%s|%s|%s\\n\' "$KIMI_API_KEY" "$MOONSHOT_API_KEY" "$KIMI_BASE_URL" "$KIMI_CODE_HOME" "$KIMI_SHARE_DIR" "$ULTRAFUZZ_KIMI_SHARED_AUTH_HOME" "$ULTRAFUZZ_KIMI_SESSION_HOME" "$ULTRAFUZZ_MODAL_REMOTE_ROOT" > "$SMITHERS_FAKE_KIMI_ENV_LOG"',
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
      'if [ -n "$SMITHERS_FAKE_SENSITIVE_ENV_LOG" ]; then',
      '  printf \'%s|%s|%s\\n\' "$1" "$ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES" "$OPENAI_SESSION_TOKEN" >> "$SMITHERS_FAKE_SENSITIVE_ENV_LOG"',
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
      `    elif [ -f ${shellQuote(alreadyPausedMarker)} ]; then`,
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
      `    if [ -f ${shellQuote(statusOverride)} ]; then`,
      `      cat ${shellQuote(statusOverride)}`,
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
    SMITHERS_FAKE_LOG: commandLog,
    ULTRAFUZZ_AGENT_ENV_ALLOWLIST: SMITHERS_TEST_ENVIRONMENT_ALLOWLIST.join(",")
  };
}

function setFakeSmithersStatus(project: string, value: unknown): void {
  fs.writeFileSync(path.join(project, "fake-smithers-status-override.json"), `${JSON.stringify(value)}\n`, "utf8");
}

function markFakeSmithersAlreadyPaused(project: string): void {
  fs.writeFileSync(path.join(project, "fake-smithers-already-paused"), "\n", "utf8");
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
  const binDir = path.join(path.dirname(project), `${path.basename(project)}-fake-ps-bin`);
  fs.mkdirSync(binDir, { recursive: true });
  const psPath = path.join(project, "fake-smithers-ps.json");
  fs.writeFileSync(psPath, `${JSON.stringify(ps, null, 2)}\n`, "utf8");
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    ["#!/bin/sh", 'if [ "$1" = "ps" ]; then', `  cat ${shellQuote(psPath)}`, "  exit 0", "fi", "exit 1", ""].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: smithers,
    SMITHERS_FAKE_PS: psPath
  };
}

const TEST_SMITHERS_DEFAULT_LIFECYCLE_EVENT_TYPES = new Set([
  "RunStarted",
  "RunStatusChanged",
  "RunStateChanged",
  "RunFinished",
  "RunFailed",
  "RunCancelled",
  "RunContinuedAsNew",
  "RunHijackRequested",
  "RunHijacked",
  "OneshotSteerQueued",
  "OneshotSteerDelivered",
  "OneshotSteerAcknowledged",
  "OneshotSteerFailed",
  "OneshotRestartRequested",
  "OneshotRestartLaunched",
  "OneshotRestartFailed",
  "RunAutoResumed",
  "RunAutoResumeSkipped",
  "RunForked",
  "AgentTraceSummary",
  "NodePending",
  "NodeStarted",
  "NodeFinished",
  "NodeFailed",
  "NodeCancelled",
  "NodeSkipped",
  "NodeRetrying",
  "NodeWaitingApproval",
  "NodeWaitingTimer",
  "ApprovalRequested",
  "ApprovalGranted",
  "ApprovalAutoApproved",
  "ApprovalDenied"
]);

function fakeLifecycleSmithersEnv(
  project: string,
  input: {
    inspect: unknown;
    resumeInspect?: unknown;
    failInspectOnInvocation?: number;
    events?: string;
    tokenEvents?: string;
    inspectMarkerPath?: string;
    timeline?: unknown;
    statusEvents?: unknown;
    status?: unknown;
    why?: unknown;
    nodeDetails?: Record<string, unknown>;
    attemptSelections?: Record<string, Record<number, { chainIndex: number; profileId: string; model: string | null }>>;
    enforceWorkflowChangeAcceptance?: boolean;
    failWorkflowChangeAdmissionOnce?: boolean;
    emulatePatchedLifecycleFilter?: boolean;
  }
): Record<string, string | undefined> {
  const binDir = path.join(path.dirname(project), `${path.basename(project)}-fake-lifecycle-bin`);
  fs.mkdirSync(binDir, { recursive: true });
  const inspectPath = path.join(project, "fake-smithers-inspect.json");
  const resumeInspectPath = path.join(project, "fake-smithers-resume-inspect.json");
  const inspectCountPath = path.join(project, "fake-smithers-inspect-count");
  const eventsPath = path.join(project, "fake-smithers-events.ndjson");
  const tokenEventsPath =
    input.tokenEvents === undefined ? eventsPath : path.join(project, "fake-smithers-token-events.ndjson");
  const timelinePath = path.join(project, "fake-smithers-timeline.json");
  const statusEventsPath = path.join(project, "fake-smithers-status-events.json");
  const statusPath = path.join(project, "fake-smithers-status.json");
  const whyPath = path.join(project, "fake-smithers-why.json");
  const workflowChangeAcceptedMarkerPath = path.join(project, "fake-smithers-workflow-change-accepted");
  const workflowChangeFailureMarkerPath = path.join(project, "fake-smithers-workflow-change-failed");
  const nodeDetailsDirectory = path.join(project, "fake-smithers-node-details");
  fs.writeFileSync(inspectPath, `${JSON.stringify(input.inspect, null, 2)}\n`, "utf8");
  if (input.resumeInspect !== undefined) {
    fs.writeFileSync(resumeInspectPath, `${JSON.stringify(input.resumeInspect, null, 2)}\n`, "utf8");
  }
  fs.writeFileSync(inspectCountPath, "0\n", "utf8");
  const lifecycleEvents =
    input.emulatePatchedLifecycleFilter === true
      ? (input.events ?? "")
          .trim()
          .split("\n")
          .filter(Boolean)
          .filter((line) => {
            const event = JSON.parse(line) as { type?: unknown };
            return typeof event.type === "string" && TEST_SMITHERS_DEFAULT_LIFECYCLE_EVENT_TYPES.has(event.type);
          })
          .join("\n") + "\n"
      : (input.events ?? "");
  fs.writeFileSync(eventsPath, lifecycleEvents, "utf8");
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
  fs.writeFileSync(statusPath, `${JSON.stringify(input.status ?? currentStatusEnvelope(), null, 2)}\n`, "utf8");
  fs.writeFileSync(
    whyPath,
    `${JSON.stringify(
      input.why ?? {
        ok: true,
        data: {
          runId: "unconfigured-run",
          status: "running",
          summary: "run is active",
          generatedAtMs: 1,
          blockers: [],
          information: [],
          currentNodeId: null
        },
        meta: { command: "why", duration: "1ms" }
      },
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
  for (const [nodeId, detail] of Object.entries(input.nodeDetails ?? {})) {
    fs.writeFileSync(path.join(nodeDetailsDirectory, `${nodeId}.json`), `${JSON.stringify(detail, null, 2)}\n`, "utf8");
  }
  const smithers = path.join(binDir, "smithers");
  const commandLog = path.join(project, "smithers-commands.log");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellQuote(commandLog)}`,
      'case "$1" in',
      "  inspect)",
      `    inspect_count=$(cat ${shellQuote(inspectCountPath)})`,
      "    inspect_count=$((inspect_count + 1))",
      `    printf '%s\\n' "$inspect_count" > ${shellQuote(inspectCountPath)}`,
      ...(input.failInspectOnInvocation === undefined
        ? []
        : [
            `    if [ "$inspect_count" -eq ${input.failInspectOnInvocation} ]; then`,
            "      printf '%s\\n' 'fake inspect failure' >&2",
            "      exit 1",
            "    fi"
          ]),
      ...(input.inspectMarkerPath === undefined ? [] : [`    touch ${shellQuote(input.inspectMarkerPath)}`]),
      `    cat ${shellQuote(inspectPath)}`,
      "    ;;",
      "  node)",
      `    cat ${shellQuote(nodeDetailsDirectory)}/"$2.json"`,
      "    ;;",
      "  cancel)",
      '    printf \'%s\\n\' \'{"ok":true,"data":{"status":"cancel-requested"}}\'',
      "    exit 2",
      "    ;;",
      "  events)",
      '    case "$*" in',
      `      *--full-output*) cat ${shellQuote(statusEventsPath)} ;;`,
      '      *) if [ "$3" = "--type" ] && [ "$4" = "token" ]; then',
      `           cat ${shellQuote(tokenEventsPath)}`,
      "         else",
      `           cat ${shellQuote(eventsPath)}`,
      "         fi ;;",
      "    esac",
      "    ;;",
      "  timeline)",
      `    cat ${shellQuote(timelinePath)}`,
      "    ;;",
      "  status)",
      `    cat ${shellQuote(statusPath)}`,
      "    ;;",
      "  why)",
      `    cat ${shellQuote(whyPath)}`,
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
      ...(input.enforceWorkflowChangeAcceptance === true
        ? [
            `    if [ ! -f ${shellQuote(workflowChangeAcceptedMarkerPath)} ]; then`,
            '      case " $* " in',
            '        *" --resume "*)',
            '        case " $* " in',
            ...(input.failWorkflowChangeAdmissionOnce === true
              ? [
                  '          *" --accept-workflow-change "*)',
                  `            if [ ! -f ${shellQuote(workflowChangeFailureMarkerPath)} ]; then`,
                  `              : > ${shellQuote(workflowChangeFailureMarkerPath)}`,
                  "              printf '%s\\n' 'injected admission failure after workflow-change authorization' >&2",
                  "              exit 1",
                  "            fi",
                  `            : > ${shellQuote(workflowChangeAcceptedMarkerPath)}`,
                  "            ;;"
                ]
              : [`          *" --accept-workflow-change "*) : > ${shellQuote(workflowChangeAcceptedMarkerPath)} ;;`]),
            "          *) printf '%s\\n' 'RESUME_METADATA_MISMATCH' >&2; exit 1 ;;",
            "        esac",
            "        ;;",
            "      esac",
            "    fi"
          ]
        : []),
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
      ...(input.resumeInspect === undefined
        ? []
        : [
            '    case "$*" in',
            `      *--resume*) cp ${shellQuote(resumeInspectPath)} ${shellQuote(inspectPath)} ;;`,
            "    esac"
          ]),
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
    SMITHERS_FAKE_LOG: commandLog,
    SMITHERS_FAKE_INSPECT: inspectPath,
    SMITHERS_FAKE_EVENTS: eventsPath,
    SMITHERS_FAKE_TOKEN_EVENTS: tokenEventsPath,
    SMITHERS_FAKE_STATUS_EVENTS: statusEventsPath,
    SMITHERS_FAKE_STATUS: statusPath,
    SMITHERS_FAKE_WHY: whyPath,
    SMITHERS_FAKE_TIMELINE: timelinePath,
    SMITHERS_FAKE_NODE_DETAILS: nodeDetailsDirectory,
    ULTRAFUZZ_PRICING_CATALOG_URL: "off",
    ULTRAFUZZ_AGENT_ENV_ALLOWLIST: SMITHERS_TEST_ENVIRONMENT_ALLOWLIST.join(",")
  };
}

function pricingCatalogDataUrl(catalog: unknown): string {
  const url = `https://pricing.test/catalog-${testPricingCatalogSequence++}.json`;
  testPricingCatalogs.set(url, JSON.stringify(catalog));
  return url;
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

function missingSmithersInspect(
  databasePath: string,
  kind: "history" | "database" = "history"
): Record<string, unknown> {
  // Captured from the pinned runner's `inspect --format json --full-output`
  // contract. Incur appends the stable error-reference suffix to the store
  // error emitted by Smithers.
  const missingState = kind === "history" ? "Smithers run history" : "smithers.db";
  return {
    ok: false,
    error: {
      code: "INSPECT_FAILED",
      message: `No ${missingState} found at ${databasePath}. Run 'smithers up <workflow>' to start a run first. See https://smithers.sh/reference/errors`
    },
    meta: { command: "inspect", duration: "1ms" }
  };
}

function controllerRefreshTerminalEnv(
  project: string,
  runId: string,
  options: { enforceWorkflowChangeAcceptance?: boolean; failWorkflowChangeAdmissionOnce?: boolean } = {}
): Record<string, string | undefined> {
  return fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: `ultrafuzz-${runId}`,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    }),
    enforceWorkflowChangeAcceptance: options.enforceWorkflowChangeAcceptance,
    failWorkflowChangeAdmissionOnce: options.failWorkflowChangeAdmissionOnce
  });
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
      dependencyArtifactDirs?: string[];
      optionalDependencyArtifactDirs?: string[];
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
  const optionalAttemptIds = new Set(
    (task.optionalDependencyArtifactDirs ?? []).map((directory) => path.basename(directory))
  );
  const admittedDependencyAttemptIds = (task.dependencyArtifactDirs ?? [])
    .map((directory) => path.basename(directory))
    .filter(
      (dependencyAttemptId) =>
        !optionalAttemptIds.has(dependencyAttemptId) ||
        fs.existsSync(path.join(runRoot, ".ultrafuzz-verification", `${dependencyAttemptId}.json`))
    );
  const marker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: attemptId,
    node_id: task.logicalNodeId,
    admitted_dependency_attempt_ids: admittedDependencyAttemptIds,
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

function renderedValidatorCommandCounts(renderedPrompt: string): {
  schemaPaths: number;
  jsonCommands: number;
  contractCommands: number;
} {
  const lines = renderedPrompt.split("\n");
  return {
    schemaPaths: lines.filter((line) => line.startsWith("  Validate against: ")).length,
    jsonCommands: lines.filter((line) => line.startsWith("  Validation command: `ultrafuzz json validate --schema "))
      .length,
    contractCommands: lines.filter((line) =>
      line.startsWith("  Contract validation command: `ultrafuzz artifact validate ")
    ).length
  };
}

function writeOptionalSpecialistTopology(
  project: string,
  options: { specialistCommand?: string; blockingCommand?: string } = {}
): void {
  const requiredCommands = (command: string | undefined): string =>
    command === undefined ? "" : `\n    required_commands: [${command}]`;
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
groups:
  core:
    label: Core
  specialists:
    label: Optional specialists
    defaults:
      failure_policy: continue
  review:
    label: Review
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: direct-strategy
    kind: agentic
    prompt: setup/runtime-fixture.md
    group: core${requiredCommands(options.blockingCommand)}
    depends_on: [__start__]
    outputs:
      - path: ${GENERIC_RUNTIME_MARKDOWN_PATH}
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: optional-specialist
    kind: agentic
    prompt: setup/runtime-fixture.md
    group: specialists${requiredCommands(options.specialistCommand)}
    depends_on: [__start__]
    outputs:
      - path: ${GENERIC_RUNTIME_MARKDOWN_PATH}
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: final-report
    kind: agentic
    prompt: setup/runtime-fixture.md
    group: review
    depends_on: [direct-strategy, optional-specialist]
    outputs:
      - path: ${GENERIC_RUNTIME_MARKDOWN_PATH}
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on: [final-report]
`,
    "utf8"
  );
  writeNeutralRuntimeFixturePrompt(project);
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
  initProject({ projectRoot: project, force: true });
  fs.mkdirSync(path.join(project, ".ultrafuzz", "workspaces"), { recursive: true });
  fs.mkdirSync(path.join(project, ".ultrafuzz", "prompts", "setup"), { recursive: true });
  fs.mkdirSync(path.join(project, ".ultrafuzz", "prompts", "strategies"), { recursive: true });
  fs.mkdirSync(path.join(project, ".smithers", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "test-agent-index.ts"),
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

testWhen(process.platform !== "win32" && fs.existsSync("/proc/self/fd"))(
  "init supports Modal-style directory and child device splits without weakening file identity checks",
  { concurrency: false },
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

test("init resolves one-hour node and execution-resource timeout defaults", () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));

  const config = fs.readFileSync(path.join(project, "ultrafuzz.toml"), "utf8");
  const parsed = parseProjectConfigToml(config);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const resolved = resolveConfig({ env: {}, projectConfig: parsed.value });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  assert.equal(resolved.value?.run.defaultTimeoutSeconds, 3600);
  assert.equal(resolved.value?.execution.resources.timeoutSeconds, 3600);
});

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
  assert.equal(fs.existsSync(path.join(project, ".smithers/agents/pi.ts")), true);
  const agentsIndexText = fs.readFileSync(path.join(project, ".smithers/agents/index.ts"), "utf8");
  assert.match(agentsIndexText, /export \{ createCodexAgent \} from ".\/codex";/);
  assert.match(agentsIndexText, /export \{ createClaudeAgent \} from ".\/claude";/);
  assert.match(agentsIndexText, /export \{ createDeepSeekAgent \} from ".\/deepseek";/);
  assert.match(agentsIndexText, /export \{ createKimiAgent \} from ".\/kimi";/);
  assert.match(agentsIndexText, /export \{ createPiAgent \} from ".\/pi";/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*ClaudeAgent: createClaudeAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*CodexAgent: createCodexAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*DeepSeekAgent: createDeepSeekAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*KimiAgent: createKimiAgent/);
  assert.match(agentsIndexText, /agentFactories = \{[^}]*PiAgent: createPiAgent/);
  // Importing the registry must not construct any agent: doing so reads that
  // agent's auth and fails a project that only uses the other backend.
  assert.doesNotMatch(agentsIndexText, /=\s*create(Codex|Claude|DeepSeek|Kimi|Pi)Agent\(\)/);
  assert.doesNotMatch(codexAgentText, /=\s*createCodexAgent\(\)/);
  const claudeAgentText = fs.readFileSync(path.join(project, ".smithers/agents/claude.ts"), "utf8");
  assert.match(claudeAgentText, /ClaudeCodeAgent/);
  assert.match(claudeAgentText, /createClaudeAgent/);
  assert.match(claudeAgentText, /permissionMode:\s*"bypassPermissions"/);
  assert.match(claudeAgentText, /settingSources:\s*"user"/);
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
  assert.match(deepSeekAgentText, /settingSources:\s*""/);
  assert.match(deepSeekAgentText, /effort:\s*reasoningEffort/);
  assert.doesNotMatch(deepSeekAgentText, /extraArgs:\s*\["--effort"/);
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
  const stock032Source = fs.readFileSync(path.resolve("test/fixtures/smithers-0.32-codex.txt"), "utf8");
  assert.equal(
    crypto.createHash("sha256").update(stock032Source).digest("hex"),
    "7865f1be1715d36d016c7b2814081b70e70a9aca7e30d5b41f5d91bf2337f681"
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

test("startRun rejects a customized controller adapter before submission", async () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  writeSmallTopology(project);
  const codexPath = path.join(project, ".smithers", "agents", "codex.ts");
  fs.writeFileSync(codexPath, 'export const customConfig = "ultrafuzz.toml"; // project-owned adapter\n', "utf8");

  const run = await startRun({ projectRoot: project, runId: "stale-custom-agent", env: fakeSmithersEnv(project) });

  assert.equal(run.ok, false);
  assert.equal(run.diagnostics[0]?.code, "CONTROLLER_SOURCE_UNTRUSTED");
  assert.match(run.diagnostics[0]?.message ?? "", /must exactly match the packaged stock closure/u);
  assert.match(run.diagnostics[0]?.message ?? "", /ultrafuzz init --force/u);
  assert.equal(fs.existsSync(path.join(project, "smithers-commands.log")), false);
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

bunAdapterTest(
  "generated Codex commands accept a sealed ambient proxy and reject drift",
  { timeout: 30_000 },
  async () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const { CompatibleCodexAgent, workflowControlChildEnvironment } = await loadGeneratedCodexAgent(project);
    const snapshot = path.join(project, "execution-snapshot"),
      authority = path.join(snapshot, "controls/data-governance.json");
    fs.mkdirSync(path.dirname(authority), { recursive: true });
    const names = [
        "ALL_PROXY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "all_proxy",
        "http_proxy",
        "https_proxy",
        "no_proxy",
        "ULTRAFUZZ_DATA_GOVERNANCE_PATH",
        "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH"
      ],
      saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    process.env.ULTRAFUZZ_DATA_GOVERNANCE_PATH = authority;
    process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH = path.join(snapshot, ".smithers/workflows/test.tsx");
    try {
      process.env.HTTPS_PROXY = "https://proxy.a.invalid";
      const hash = crypto
        .createHash("sha256")
        .update(
          JSON.stringify({ agent: "CodexAgent", config: null, route: [["HTTPS_PROXY", process.env.HTTPS_PROXY]] })
        )
        .digest("hex");
      fs.writeFileSync(authority, `{"required_source_destinations":["model:codex-route-${hash}"]}`, "utf8");
      const build = () =>
        new CompatibleCodexAgent().buildCommand({ prompt: "Contract only", cwd: project, options: {} });
      const accepted = await build();
      await accepted.cleanup?.();
      assert.throws(
        () =>
          workflowControlChildEnvironment(
            {
              HTTPS_PROXY: "https://proxy.b.invalid",
              ULTRAFUZZ_DATA_GOVERNANCE_PATH: path.join(project, "forged.json")
            },
            process.env,
            { agent: "CodexAgent" }
          ),
        /provider route changed/u
      );
      process.env.HTTPS_PROXY = "https://proxy.b.invalid";
      await assert.rejects(build(), /provider route changed/u);
    } finally {
      for (const name of names) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
);

bunAdapterTest("planned routes equal final generated-adapter validation", { timeout: 30_000 }, async () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const homes = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-route-equivalence-")),
    codexHome = path.join(homes, "codex", "configured"),
    openRouterHome = path.join(homes, "openrouter", "managed"),
    snapshot = path.join(project, "route-snapshot"),
    authority = path.join(snapshot, "controls/data-governance.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(openRouterHome, { recursive: true });
  fs.mkdirSync(path.dirname(authority), { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.invalid/v1"\n'
  );
  fs.writeFileSync(
    path.join(openRouterHome, "config.toml"),
    'model_provider = "openrouter"\n[model_providers.openrouter]\nbase_url = "https://openrouter.ai/api/v1"\n'
  );
  const config = { execution: { mode: "local" }, agents: { CodexAgent: { configDir: "configured" } } } as never,
    names = [
      "ALL_PROXY",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "all_proxy",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "OPENAI_BASE_URL",
      "ULTRAFUZZ_AGENT_ENV_ALLOWLIST",
      "ULTRAFUZZ_DATA_GOVERNANCE_PATH",
      "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH"
    ],
    saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.ULTRAFUZZ_DATA_GOVERNANCE_PATH = authority;
  process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH = path.join(snapshot, ".smithers/workflows/test.tsx");
  try {
    const codexDestination = modelDestination("CodexAgent", config, { ULTRAFUZZ_PROVIDER_HOME_ROOT: homes });
    fs.writeFileSync(authority, JSON.stringify({ required_source_destinations: [codexDestination] }));
    const { CompatibleCodexAgent, workflowControlChildEnvironment } = await loadGeneratedCodexAgent(project),
      codex = await new CompatibleCodexAgent({
        configDir: codexHome,
        env: { OPENAI_BASE_URL: "https://gateway.invalid/v1" }
      }).buildCommand({ prompt: "route", cwd: project, options: {} });
    await codex.cleanup?.();
    const openRouterDestination = modelDestination("OpenRouterAgent", config, {});
    fs.writeFileSync(authority, JSON.stringify({ required_source_destinations: [openRouterDestination] }));
    const { OpenRouterCodexAgent } = await loadGeneratedOpenRouterAgent(project),
      openrouter = await new OpenRouterCodexAgent({
        configDir: openRouterHome,
        env: { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" }
      }).buildCommand({ prompt: "route", cwd: project, options: {} });
    await (openrouter.cleanup as (() => Promise<void>) | undefined)?.();
    const claudeEnv = {
        ULTRAFUZZ_PROVIDER_HOME_ROOT: homes,
        ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "AWS_REGION",
        AWS_REGION: "us-east-1",
        ULTRAFUZZ_DATA_GOVERNANCE_PATH: authority,
        ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH
      },
      claudeDestination = modelDestination("ClaudeAgent", config, claudeEnv);
    fs.writeFileSync(authority, JSON.stringify({ required_source_destinations: [claudeDestination] }));
    assert.doesNotThrow(() => workflowControlChildEnvironment({}, claudeEnv, { agent: "ClaudeAgent" }));
    assert.throws(
      () =>
        workflowControlChildEnvironment({}, { ...claudeEnv, CLAUDE_CODE_USE_BEDROCK: "1" }, { agent: "ClaudeAgent" }),
      /provider route changed/u
    );
    assert.equal(codexDestination.startsWith("model:codex-route-"), true);
    assert.equal(openRouterDestination, "model:openrouter");
    assert.equal(claudeDestination.startsWith("model:claude-route-"), true);
  } finally {
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

bunAdapterTest(
  "generated Claude route validation ignores Azure CLI extension plumbing",
  { timeout: 30_000 },
  async () => {
    const project = tempProject();
    assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
    const snapshot = path.join(project, "route-snapshot");
    const authority = path.join(snapshot, "controls", "data-governance.json");
    const claudeHome = path.join(project, "claude-home");
    fs.mkdirSync(path.dirname(authority), { recursive: true });
    fs.mkdirSync(claudeHome);
    fs.writeFileSync(
      path.join(claudeHome, "settings.json"),
      '{"env":{"AZURE_EXTENSION_DIR":"/opt/az/azcliextensions"}}',
      "utf8"
    );
    fs.writeFileSync(authority, '{"required_source_destinations":["model:anthropic"]}', "utf8");
    const { workflowControlChildEnvironment } = await loadGeneratedCodexAgent(project);
    const child = workflowControlChildEnvironment(
      { AZURE_EXTENSION_DIR: "/opt/az/azcliextensions" },
      {
        AZURE_EXTENSION_DIR: "/opt/az/azcliextensions",
        ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "AZURE_EXTENSION_DIR",
        ULTRAFUZZ_DATA_GOVERNANCE_PATH: authority,
        ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: path.join(snapshot, ".smithers", "workflows", "test.tsx")
      },
      { agent: "ClaudeAgent", configDir: claudeHome }
    );
    assert.equal(child.AZURE_EXTENSION_DIR, "/opt/az/azcliextensions");
  }
);

bunAdapterTest("quoted TOML provider routes are bound and drift fails closed", { timeout: 30_000 }, async () => {
  const project = tempProject();
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const homes = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-quoted-route-")),
    codexHome = path.join(homes, "codex", "configured"),
    configPath = path.join(codexHome, "config.toml"),
    snapshot = path.join(project, "route-snapshot"),
    authority = path.join(snapshot, "controls/data-governance.json"),
    names = [
      "ALL_PROXY",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "all_proxy",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "OPENAI_BASE_URL",
      "ULTRAFUZZ_AGENT_ENV_ALLOWLIST",
      "ULTRAFUZZ_DATA_GOVERNANCE_PATH",
      "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH"
    ],
    saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.dirname(authority), { recursive: true });
  fs.writeFileSync(
    configPath,
    '"model_provider" = "gateway"\n["model_providers"."gateway"]\n"base_url" = "https://gateway.invalid/v1"\n'
  );
  for (const name of names) delete process.env[name];
  process.env.ULTRAFUZZ_DATA_GOVERNANCE_PATH = authority;
  process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH = path.join(snapshot, ".smithers/workflows/test.tsx");
  try {
    const config = { execution: { mode: "local" }, agents: { CodexAgent: { configDir: "configured" } } } as never,
      destination = modelDestination("CodexAgent", config, { ULTRAFUZZ_PROVIDER_HOME_ROOT: homes });
    assert.match(destination, /^model:codex-route-/u);
    fs.writeFileSync(authority, JSON.stringify({ required_source_destinations: [destination] }));
    const { CompatibleCodexAgent } = await loadGeneratedCodexAgent(project),
      accepted = await new CompatibleCodexAgent({ configDir: codexHome }).buildCommand({
        prompt: "route",
        cwd: project,
        options: {}
      });
    await accepted.cleanup?.();
    fs.writeFileSync(
      configPath,
      '"model_provider" = "drifted"\n["model_providers"."drifted"]\n"base_url" = "https://drifted.invalid/v1"\n'
    );
    await assert.rejects(
      new CompatibleCodexAgent({ configDir: codexHome }).buildCommand({ prompt: "route", cwd: project, options: {} }),
      /provider route changed/u
    );
  } finally {
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

bunAdapterTest(
  "generated Codex adapter repeats artifact directory flags and preserves resume argv",
  { timeout: 30_000 },
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

test("linked workflow classifies sensitive allowlist values from the ambient environment", () => {
  const names = ["ULTRAFUZZ_AGENT_ENV_ALLOWLIST", "AMBIENT_RPC_URL"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST = "AMBIENT_RPC_URL";
  process.env.AMBIENT_RPC_URL = `https://eth-mainnet.g.alchemy.com/v2/${"b".repeat(32)}`;
  try {
    const ambient = linkedWorkflowExecutionEnvironment({ executionSnapshot: { env: {} } } as never, undefined);
    assert.equal(ambient.ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES, "AMBIENT_RPC_URL");

    const explicitlyReplaced = linkedWorkflowExecutionEnvironment({ executionSnapshot: { env: {} } } as never, {
      ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "FOUNDRY_PROFILE",
      FOUNDRY_PROFILE: "ci"
    });
    assert.equal(explicitlyReplaced.ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES, "");
  } finally {
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

bunAdapterTest(
  "generated CodexAgent subscription auth routes the credential preflight at the CLI's configured provider",
  { timeout: 30_000 },
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
    const codexHome = path.join(process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT!, "codex");
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });

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

bunAdapterTest(
  "generated CodexAgent API-key auth preflights the configured custom provider with its named credential",
  { timeout: 30_000 },
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
    const providerHomeRoot = path.join(project, "operator-provider-homes");
    const codexHome = path.join(providerHomeRoot, "codex", "openrouter-codex");
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
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
            'config_dir = "openrouter-codex"'
          ].join("\n")
        ),
      "utf8"
    );

    const previous = {
      baseUrl: process.env.OPENAI_BASE_URL,
      codexHome: process.env.CODEX_HOME,
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      openRouterKey: process.env.OPENROUTER_API_KEY,
      providerHomeRoot: process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.OPENROUTER_API_KEY = "openrouter-test-key";
    process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT = providerHomeRoot;
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
        const execution = await runSpawnedCommand({
          command: command.command,
          args: command.args,
          cwd: project,
          env: { ...process.env, ...agent.opts.env, ...command.env },
          stdin: command.stdin,
          timeoutMs: 20_000
        });
        assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}\n${JSON.stringify(requests)}`);
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
        const execution = await runSpawnedCommand({
          command: alternateTomlCommand.command,
          args: alternateTomlCommand.args,
          cwd: project,
          env: { ...process.env, ...alternateTomlAgent.opts.env, ...alternateTomlCommand.env },
          stdin: alternateTomlCommand.stdin,
          timeoutMs: 20_000
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
      if (previous.providerHomeRoot === undefined) delete process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT;
      else process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT = previous.providerHomeRoot;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }
);

bunAdapterTest(
  "generated OpenRouter adapter preserves opaque model IDs and enables the authenticated provider catalogue",
  { timeout: 30_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const configPath = path.join(project, "ultrafuzz.toml");
    const providerHomeRoot = path.join(project, ".ultrafuzz", "provider-homes");
    const codexHome = path.join(providerHomeRoot, "openrouter", "openrouter-test-codex");
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace(
          '[agents.OpenRouterAgent]\nauth = "api-key"\napi_key_env = "OPENROUTER_API_KEY"',
          '[agents.OpenRouterAgent]\nauth = "api-key"\napi_key_env = "OPENROUTER_API_KEY"\nconfig_dir = "openrouter-test-codex"'
        ),
      "utf8"
    );
    const { createOpenRouterAgent } = await loadGeneratedOpenRouterAgent(project);
    const model = "~vendor/model.latest:free+preview@2026";
    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      providerHomeRoot: process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT,
      openrouter: process.env.OPENROUTER_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT = providerHomeRoot;
    process.env.OPENROUTER_API_KEY = "deterministic-openrouter-test-key";
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
      assert.equal(command.env?.OPENROUTER_API_KEY, "deterministic-openrouter-test-key");
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
          'args = ["-e", "process.stdout.write(process.env[process.argv[1]] ?? \'\')", "OPENROUTER_API_KEY"]',
          ""
        ].join("\n")
      );
      assert.equal(providerConfig.includes("deterministic-openrouter-test-key"), false);
      assert.equal(fs.statSync(codexHome).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(codexHome, "config.toml")).mode & 0o777, 0o600);
    } finally {
      for (const [name, value] of Object.entries({
        ULTRAFUZZ_CONFIG_PATH: previous.config,
        ULTRAFUZZ_PROVIDER_HOME_ROOT: previous.providerHomeRoot,
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

bunAdapterTest(
  "generated OpenRouter adapter bounds its 429 recovery policy independently from caller timeout",
  { timeout: 30_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { decideOpenRouter429Recovery } = await loadGeneratedOpenRouterAgent(project);

    const baseDelays = [0, 1, 2, 3, 4, 5, 6].map((retryAttempt) =>
      decideOpenRouter429Recovery({
        retryAttempt,
        nowMs: 0,
        retryDeadlineMs: 120_000,
        random: 0
      })
    );
    assert.deepEqual(
      baseDelays.map((decision) => (decision.kind === "backoff" ? decision.delayMs : decision.kind)),
      [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
    );
    assert.deepEqual(
      decideOpenRouter429Recovery({
        retryAttempt: 5,
        nowMs: 0,
        retryDeadlineMs: 120_000,
        random: 1
      }),
      { kind: "backoff", delayMs: 37_499, afterDelay: "retry" }
    );
    assert.deepEqual(
      decideOpenRouter429Recovery({
        retryAttempt: 8,
        nowMs: 119_500,
        retryDeadlineMs: 120_000,
        random: 0
      }),
      { kind: "rate-limit-exhausted" }
    );
    assert.deepEqual(
      decideOpenRouter429Recovery({
        retryAttempt: 0,
        nowMs: 0,
        retryDeadlineMs: 500,
        totalDeadlineMs: 500,
        random: 0
      }),
      { kind: "backoff", delayMs: 500, afterDelay: "total-timeout" }
    );
    assert.deepEqual(
      decideOpenRouter429Recovery({
        retryAttempt: 0,
        nowMs: 120_000,
        retryDeadlineMs: 120_000,
        random: 0
      }),
      { kind: "rate-limit-exhausted" }
    );
    assert.deepEqual(
      decideOpenRouter429Recovery({
        retryAttempt: 0,
        nowMs: 1,
        retryDeadlineMs: 120_000,
        totalDeadlineMs: 1,
        random: 0
      }),
      { kind: "total-timeout" }
    );
  }
);

bunAdapterTest(
  "generated OpenRouter adapter decreases one caller timeout across exact-session recovery",
  { timeout: 10_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { OpenRouterCodexAgent } = await loadGeneratedOpenRouterAgent(project, {
      retryWindowMs: 5_000,
      initialDelayMs: 1,
      maxDelayMs: 1,
      jitterFraction: 0
    });
    const agent = new OpenRouterCodexAgent({ model: "openai/gpt-5.6-luna" });
    const observedTimeouts: number[] = [];
    let invocation = 0;
    agent.buildCommand = async (params) => {
      invocation += 1;
      const timeout = params.options.timeout;
      const totalMs =
        typeof timeout === "number"
          ? timeout
          : timeout !== null && typeof timeout === "object" && "totalMs" in timeout
            ? (timeout as { totalMs?: unknown }).totalMs
            : undefined;
      assert.equal(typeof totalMs, "number");
      observedTimeouts.push(totalMs as number);
      const rateLimitMessage = `last status: 429 Too Many Requests, request id: timeout-${invocation}`;
      const lines: Record<string, unknown>[] = [
        { type: "thread.started", thread_id: "timeout-session" },
        { type: "turn.started" }
      ];
      if (invocation === 1) {
        lines.push({
          type: "item.completed",
          item: { id: "progress", type: "agent_message", text: "substantive progress" }
        });
      }
      if (invocation < 3) {
        lines.push({ type: "error", message: rateLimitMessage });
        lines.push({ type: "turn.failed", error: { message: rateLimitMessage } });
      } else {
        lines.push({ type: "item.completed", item: { id: "answer", type: "agent_message", text: "OK" } });
        lines.push({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } });
      }
      const script = `${lines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`).join("")} ${
        invocation < 3 ? "process.exitCode = 1;" : ""
      }`;
      return { command: process.execPath, args: ["-e", script], outputFormat: "stream-json" };
    };

    const result = await agent.generate({ prompt: "One total timeout", timeout: { totalMs: 2_000 } });

    assert.equal(result.text, "OK");
    assert.equal(invocation, 3);
    assert.equal(observedTimeouts.length, 3);
    assert.equal(observedTimeouts[0]! > observedTimeouts[1]!, true);
    assert.equal(observedTimeouts[1]! > observedTimeouts[2]!, true);
    assert.equal(
      observedTimeouts.every((timeout) => timeout <= 2_000 && timeout > 0),
      true
    );
  }
);

bunAdapterTest(
  "generated OpenRouter adapter does not start a request after event-loop delay crosses its recovery deadline",
  { timeout: 5_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { OpenRouterCodexAgent } = await loadGeneratedOpenRouterAgent(project, {
      retryWindowMs: 500,
      initialDelayMs: 1,
      maxDelayMs: 1,
      jitterFraction: 0
    });
    const agent = new OpenRouterCodexAgent({ model: "openai/gpt-5.6-luna" });
    let invocation = 0;
    let delayedPastDeadline = false;
    agent.buildCommand = async () => {
      invocation += 1;
      const message = `last status: 429 Too Many Requests, request id: deadline-${invocation}`;
      const lines = [
        { type: "thread.started", thread_id: "deadline-session" },
        { type: "turn.started" },
        { type: "error", message },
        { type: "turn.failed", error: { message } }
      ];
      const script = `${lines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`).join("")} process.exitCode = 1;`;
      return { command: process.execPath, args: ["-e", script], outputFormat: "stream-json" };
    };

    await assert.rejects(
      agent.generate({
        prompt: "Do not cross the recovery deadline",
        onStderr: (text: string) => {
          if (!text.includes("[ultrafuzz]") || delayedPastDeadline) return;
          delayedPastDeadline = true;
          const unblockAt = performance.now() + 600;
          while (performance.now() < unblockAt) {
            // Deliberately delay the retry timer past its independently
            // bounded window, as a busy host event loop can do in production.
          }
        }
      }),
      /request id: deadline-1/u
    );
    assert.equal(delayedPastDeadline, true);
    assert.equal(invocation, 1);
  }
);

bunAdapterTest(
  "generated OpenRouter adapter checks recovery and caller deadlines after asynchronous command construction",
  { timeout: 5_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { OpenRouterCodexAgent } = await loadGeneratedOpenRouterAgent(project, {
      retryWindowMs: 500,
      initialDelayMs: 1,
      maxDelayMs: 1,
      jitterFraction: 0
    });
    type ParentBuildCommand = (params: unknown) => Promise<{ command: string; args: string[]; outputFormat: string }>;
    const parentPrototype = Object.getPrototypeOf(OpenRouterCodexAgent.prototype) as {
      buildCommand: ParentBuildCommand;
    };
    const originalParentBuildCommand = parentPrototype.buildCommand;
    try {
      let recoveryBuilds = 0;
      let recoveryProcessStarts = 0;
      parentPrototype.buildCommand = async () => {
        recoveryBuilds += 1;
        if (recoveryBuilds === 2) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
        }
        const message = "last status: 429 Too Many Requests, request id: delayed-build-" + String(recoveryBuilds);
        const lines =
          recoveryBuilds === 1
            ? [
                { type: "thread.started", thread_id: "delayed-build-session" },
                { type: "turn.started" },
                { type: "error", message },
                { type: "turn.failed", error: { message } }
              ]
            : [
                { type: "thread.started", thread_id: "delayed-build-session" },
                { type: "turn.started" },
                { type: "item.completed", item: { id: "answer", type: "agent_message", text: "WRONG" } },
                { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } }
              ];
        const script = lines.map((line) => "console.log(" + JSON.stringify(JSON.stringify(line)) + ");").join("");
        return {
          command: process.execPath,
          args: ["-e", script + (recoveryBuilds === 1 ? "process.exitCode = 1;" : "")],
          outputFormat: "stream-json"
        };
      };
      const recoveryAgent = new OpenRouterCodexAgent({ model: "openai/gpt-5.6-luna" });
      await assert.rejects(
        recoveryAgent.generate({
          prompt: "Do not spawn after delayed recovery command construction",
          onProcess: (event: { phase: "started" | "exited" }) => {
            if (event.phase === "started") recoveryProcessStarts += 1;
          }
        }),
        /request id: delayed-build-1/u
      );
      assert.equal(recoveryBuilds, 2);
      assert.equal(recoveryProcessStarts, 1);

      let totalBuilds = 0;
      let totalProcessStarts = 0;
      parentPrototype.buildCommand = async () => {
        totalBuilds += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        return {
          command: process.execPath,
          args: ["-e", 'console.log("must not start");'],
          outputFormat: "stream-json"
        };
      };
      const totalAgent = new OpenRouterCodexAgent({ model: "openai/gpt-5.6-luna" });
      await assert.rejects(
        totalAgent.generate({
          prompt: "Do not spawn after delayed caller timeout",
          timeout: 50,
          onProcess: (event: { phase: "started" | "exited" }) => {
            if (event.phase === "started") totalProcessStarts += 1;
          }
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, "PROCESS_TIMEOUT");
          return true;
        }
      );
      assert.equal(totalBuilds, 1);
      assert.equal(totalProcessStarts, 0);

      let absoluteBuilds = 0;
      let absoluteProcessStarts = 0;
      parentPrototype.buildCommand = async () => {
        absoluteBuilds += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
        const successLines = [
          { type: "thread.started", thread_id: "late-success-session" },
          { type: "turn.started" },
          { type: "item.completed", item: { id: "answer", type: "agent_message", text: "LATE" } },
          { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } }
        ];
        const script =
          "setTimeout(() => {" +
          successLines.map((line) => "console.log(" + JSON.stringify(JSON.stringify(line)) + ");").join("") +
          "}, 100);";
        return { command: process.execPath, args: ["-e", script], outputFormat: "stream-json" };
      };
      const absoluteAgent = new OpenRouterCodexAgent({ model: "openai/gpt-5.6-luna" });
      await assert.rejects(
        absoluteAgent.generate({
          prompt: "Carry the absolute caller deadline into a late-starting child",
          timeout: 120,
          onProcess: (event: { phase: "started" | "exited" }) => {
            if (event.phase === "started") absoluteProcessStarts += 1;
          }
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, "PROCESS_TIMEOUT");
          return true;
        }
      );
      assert.equal(absoluteBuilds, 1);
      assert.equal(absoluteProcessStarts, 1);
    } finally {
      parentPrototype.buildCommand = originalParentBuildCommand;
    }
  }
);

bunAdapterTest(
  "generated OpenRouter adapter bounds provisional callbacks and exact replay snapshots",
  { timeout: 10_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const configPath = path.join(project, "ultrafuzz.toml");
    const fixture = installOpenRouterRetryCodexFixture(project);
    const { createOpenRouterAgent } = await loadGeneratedOpenRouterAgent(
      project,
      {
        retryWindowMs: 5_000,
        initialDelayMs: 1,
        maxDelayMs: 1,
        jitterFraction: 0,
        provisionalCallbackLimit: 1,
        actionSnapshotLimit: 2,
        actionSnapshotBytes: 512
      },
      { acknowledgeProvisionalRateLimit: true }
    );
    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      key: process.env.OPENROUTER_API_KEY,
      path: process.env.PATH,
      counter: process.env.OPENROUTER_RETRY_FIXTURE_COUNTER,
      journal: process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL,
      sentinel: process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL,
      provisionalAck: process.env.OPENROUTER_RETRY_FIXTURE_PROVISIONAL_ACK,
      mode: process.env.OPENROUTER_RETRY_FIXTURE_MODE,
      failures: process.env.OPENROUTER_RETRY_FIXTURE_FAILURES
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.OPENROUTER_API_KEY = "deterministic-openrouter-test-key";
    process.env.PATH = `${fixture.bin}${path.delimiter}${previous.path ?? ""}`;
    process.env.OPENROUTER_RETRY_FIXTURE_COUNTER = fixture.counter;
    process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL = fixture.journal;
    process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL = fixture.sentinel;
    process.env.OPENROUTER_RETRY_FIXTURE_PROVISIONAL_ACK = fixture.provisionalAck;
    process.env.OPENROUTER_RETRY_FIXTURE_FAILURES = "1";
    try {
      process.env.OPENROUTER_RETRY_FIXTURE_MODE = "stderr-provisional-post-terminal";
      const overflowEvents: Record<string, unknown>[] = [];
      let overflowStdout = "";
      const overflowResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Fail closed when provisional callbacks overflow",
        onEvent: (event) => overflowEvents.push(event),
        onStdout: (text: string) => {
          overflowStdout += text;
        }
      });
      assert.equal(overflowResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.equal(fs.readFileSync(fixture.provisionalAck, "utf8"), "observed\n");
      assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "provisional-post-terminal-mutation\n");
      assert.doesNotMatch(JSON.stringify(overflowEvents), /provisional-post-terminal/u);
      assert.doesNotMatch(overflowStdout, /provisional post-terminal/u);

      fs.writeFileSync(fixture.counter, "0", "utf8");
      fs.writeFileSync(fixture.journal, "", "utf8");
      fs.rmSync(fixture.sentinel, { force: true });
      process.env.OPENROUTER_RETRY_FIXTURE_MODE = "substantive-snapshot-overflow";
      const snapshotEvents: Record<string, unknown>[] = [];
      const snapshotResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Keep recent replay snapshots within a bounded LRU",
        onEvent: (event) => snapshotEvents.push(event)
      });
      assert.equal(snapshotResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      const snapshotText = JSON.stringify(snapshotEvents);
      assert.equal((snapshotText.match(/"id":"snapshot-1"/gu) ?? []).length, 2);
      assert.equal((snapshotText.match(/"id":"snapshot-4"/gu) ?? []).length, 1);
      assert.deepEqual(
        readOpenRouterRetryFixtureJournal(fixture.journal).map((entry) => entry.invocation),
        ["fresh", "resume"]
      );

      fs.writeFileSync(fixture.counter, "0", "utf8");
      fs.writeFileSync(fixture.journal, "", "utf8");
      fs.rmSync(fixture.sentinel, { force: true });
      process.env.OPENROUTER_RETRY_FIXTURE_MODE = "substantive-stdout-oversized-replay";
      process.env.OPENROUTER_RETRY_FIXTURE_FAILURES = "3";
      let oversizedReplayStdout = "";
      const oversizedReplayResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Deduplicate an oversized stdout replay with a bounded digest",
        onStdout: (text: string) => {
          oversizedReplayStdout += text;
        }
      });
      assert.equal(oversizedReplayResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "4");
      assert.equal((oversizedReplayStdout.match(/oversized-replay-/gu) ?? []).length, 1);

      fs.writeFileSync(fixture.counter, "0", "utf8");
      fs.writeFileSync(fixture.journal, "", "utf8");
      fs.rmSync(fixture.sentinel, { force: true });
      process.env.OPENROUTER_RETRY_FIXTURE_MODE = "substantive-action-oversized-replay";
      process.env.OPENROUTER_RETRY_FIXTURE_FAILURES = "3";
      const oversizedReplayEvents: Record<string, unknown>[] = [];
      const oversizedActionResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Deduplicate an oversized action replay with a bounded digest",
        onEvent: (event) => oversizedReplayEvents.push(event)
      });
      assert.equal(oversizedActionResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "4");
      assert.equal(
        oversizedReplayEvents.filter((event) => JSON.stringify(event).includes('"id":"oversized-action"')).length,
        1
      );
    } finally {
      for (const [name, value] of Object.entries({
        ULTRAFUZZ_CONFIG_PATH: previous.config,
        OPENROUTER_API_KEY: previous.key,
        PATH: previous.path,
        OPENROUTER_RETRY_FIXTURE_COUNTER: previous.counter,
        OPENROUTER_RETRY_FIXTURE_JOURNAL: previous.journal,
        OPENROUTER_RETRY_FIXTURE_SENTINEL: previous.sentinel,
        OPENROUTER_RETRY_FIXTURE_PROVISIONAL_ACK: previous.provisionalAck,
        OPENROUTER_RETRY_FIXTURE_MODE: previous.mode,
        OPENROUTER_RETRY_FIXTURE_FAILURES: previous.failures
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
);

bunAdapterTest(
  "generated OpenRouter adapter resumes null-final work and fails closed without an authoritative terminal message",
  { timeout: 60_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const configPath = path.join(project, "ultrafuzz.toml");
    const fixture = installOpenRouterRetryCodexFixture(project);
    const { createOpenRouterAgent } = await loadGeneratedOpenRouterAgent(project);
    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      key: process.env.OPENROUTER_API_KEY,
      path: process.env.PATH,
      counter: process.env.OPENROUTER_RETRY_FIXTURE_COUNTER,
      journal: process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL,
      sentinel: process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL,
      mode: process.env.OPENROUTER_RETRY_FIXTURE_MODE,
      failures: process.env.OPENROUTER_RETRY_FIXTURE_FAILURES
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.OPENROUTER_API_KEY = "deterministic-openrouter-test-key";
    process.env.PATH = `${fixture.bin}${path.delimiter}${previous.path ?? ""}`;
    process.env.OPENROUTER_RETRY_FIXTURE_COUNTER = fixture.counter;
    process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL = fixture.journal;
    process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL = fixture.sentinel;
    const resetFixture = (mode: string) => {
      fs.writeFileSync(fixture.counter, "0", "utf8");
      fs.writeFileSync(fixture.journal, "", "utf8");
      fs.rmSync(fixture.sentinel, { force: true });
      process.env.OPENROUTER_RETRY_FIXTURE_MODE = mode;
      process.env.OPENROUTER_RETRY_FIXTURE_FAILURES = "1";
    };
    const assertAgentCliError =
      (pattern: RegExp) =>
      (error: unknown): boolean => {
        assert.equal((error as { code?: unknown }).code, "AGENT_CLI_ERROR");
        assert.match(String(error), pattern);
        return true;
      };
    try {
      resetFixture("terminal-null-resume");
      const prompt = "Finish the null-final fixture exactly once";
      const events: Record<string, unknown>[] = [];
      let stderr = "";
      const result = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt,
        onEvent: (event) => events.push(event),
        onStderr: (text) => {
          stderr += text;
        }
      });
      assert.equal(result.text, "DONE");
      assert.match(stderr, /ended without a final assistant message after substantive work/u);
      assert.match(JSON.stringify(events), /I will inspect the task before I finish it\./u);
      assert.match(JSON.stringify(events), /substantive work without a final/u);
      const completions = events.filter((event) => event.type === "completed");
      assert.equal(completions.length, 1);
      assert.equal(completions[0]?.ok, true);
      assert.equal(completions[0]?.answer, "DONE");
      const recoveredJournal = readOpenRouterRetryFixtureJournal(fixture.journal);
      assert.deepEqual(
        recoveredJournal.map((entry) => entry.invocation),
        ["fresh", "resume"]
      );
      assert.equal(recoveredJournal[1]?.resumeSession, "fixture-session");
      assert.equal(recoveredJournal[0]?.stdin, prompt);
      assert.match(recoveredJournal[1]?.stdin ?? "", /OpenRouter terminal recovery marker: [0-9a-f-]+\./u);
      assert.equal(recoveredJournal.filter((entry) => entry.stdin.includes(prompt)).length, 1);
      assert.deepEqual(
        recoveredJournal.map((entry) => entry.sentinel),
        ["mutation\n", "mutation\n"]
      );

      resetFixture("terminal-null-resume");
      const streamPrompt = "Finish the streamed null-final fixture exactly once";
      const streamEvents: Record<string, unknown>[] = [];
      const streamResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).stream({
        prompt: streamPrompt,
        onEvent: (event) => streamEvents.push(event)
      });
      assert.equal(await streamResult.text, "DONE");
      assert.deepEqual(await streamResult.textStream.getReader().read(), { value: "DONE", done: false });
      const streamJournal = readOpenRouterRetryFixtureJournal(fixture.journal);
      assert.deepEqual(
        streamJournal.map((entry) => entry.invocation),
        ["fresh", "resume"]
      );
      assert.equal(streamJournal[1]?.resumeSession, "fixture-session");
      assert.equal(streamJournal.filter((entry) => entry.stdin.includes(streamPrompt)).length, 1);
      assert.equal(streamEvents.filter((event) => event.type === "completed").length, 1);

      resetFixture("terminal-null-no-session");
      const noSessionEvents: Record<string, unknown>[] = [];
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Fail closed without a session",
          onEvent: (event) => noSessionEvents.push(event)
        }),
        assertAgentCliError(/no exact session was available/u)
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "1");
      assert.deepEqual(
        readOpenRouterRetryFixtureJournal(fixture.journal).map((entry) => entry.invocation),
        ["fresh"]
      );
      assert.equal(
        noSessionEvents.some((event) => event.type === "completed"),
        false
      );

      resetFixture("terminal-null-repeat");
      const repeatedPrompt = "Fail closed after one bounded continuation";
      const repeatedEvents: Record<string, unknown>[] = [];
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: repeatedPrompt,
          onEvent: (event) => repeatedEvents.push(event)
        }),
        assertAgentCliError(/exact-session continuation also ended without a final assistant message/u)
      );
      const repeatedJournal = readOpenRouterRetryFixtureJournal(fixture.journal);
      assert.deepEqual(
        repeatedJournal.map((entry) => entry.invocation),
        ["fresh", "resume"]
      );
      assert.equal(repeatedJournal[1]?.resumeSession, "fixture-session");
      assert.equal(repeatedJournal.filter((entry) => entry.stdin.includes(repeatedPrompt)).length, 1);
      assert.equal(
        repeatedEvents.some((event) => event.type === "completed"),
        false
      );

      resetFixture("terminal-null-late-callback");
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Preserve a late caller callback failure",
          onStdout: () => {
            throw new Error("terminal null stdout callback failed");
          }
        }),
        /terminal null stdout callback failed/u
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "1");
      assert.deepEqual(
        readOpenRouterRetryFixtureJournal(fixture.journal).map((entry) => entry.invocation),
        ["fresh"]
      );
    } finally {
      for (const [name, value] of Object.entries({
        ULTRAFUZZ_CONFIG_PATH: previous.config,
        OPENROUTER_API_KEY: previous.key,
        PATH: previous.path,
        OPENROUTER_RETRY_FIXTURE_COUNTER: previous.counter,
        OPENROUTER_RETRY_FIXTURE_JOURNAL: previous.journal,
        OPENROUTER_RETRY_FIXTURE_SENTINEL: previous.sentinel,
        OPENROUTER_RETRY_FIXTURE_MODE: previous.mode,
        OPENROUTER_RETRY_FIXTURE_FAILURES: previous.failures
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
);

bunAdapterTest(
  "generated OpenRouter adapter retries before output and resumes exact sessions after substantive work",
  { timeout: 60_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const configPath = path.join(project, "ultrafuzz.toml");
    const fixture = installOpenRouterRetryCodexFixture(project);
    const { createOpenRouterAgent } = await loadGeneratedOpenRouterAgent(
      project,
      {
        retryWindowMs: 5_000,
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitterFraction: 0
      },
      { acknowledgeProvisionalRateLimit: true }
    );
    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      key: process.env.OPENROUTER_API_KEY,
      path: process.env.PATH,
      counter: process.env.OPENROUTER_RETRY_FIXTURE_COUNTER,
      journal: process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL,
      sentinel: process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL,
      provisionalAck: process.env.OPENROUTER_RETRY_FIXTURE_PROVISIONAL_ACK,
      warningAck: process.env.OPENROUTER_RETRY_FIXTURE_WARNING_ACK,
      mode: process.env.OPENROUTER_RETRY_FIXTURE_MODE,
      failures: process.env.OPENROUTER_RETRY_FIXTURE_FAILURES
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.OPENROUTER_API_KEY = "deterministic-openrouter-test-key";
    process.env.PATH = `${fixture.bin}${path.delimiter}${previous.path ?? ""}`;
    process.env.OPENROUTER_RETRY_FIXTURE_COUNTER = fixture.counter;
    process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL = fixture.journal;
    process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL = fixture.sentinel;
    process.env.OPENROUTER_RETRY_FIXTURE_PROVISIONAL_ACK = fixture.provisionalAck;
    process.env.OPENROUTER_RETRY_FIXTURE_WARNING_ACK = fixture.warningAck;
    const resetFixture = (mode: string, failures = 1) => {
      fs.writeFileSync(fixture.counter, "0", "utf8");
      fs.writeFileSync(fixture.journal, "", "utf8");
      fs.rmSync(fixture.sentinel, { force: true });
      fs.rmSync(fixture.provisionalAck, { force: true });
      fs.rmSync(fixture.warningAck, { force: true });
      process.env.OPENROUTER_RETRY_FIXTURE_MODE = mode;
      process.env.OPENROUTER_RETRY_FIXTURE_FAILURES = String(failures);
    };
    const assertExactResume = (prompt: string) => {
      const journal = readOpenRouterRetryFixtureJournal(fixture.journal);
      assert.equal(journal.length, 2);
      assert.equal(journal[0]?.invocation, "fresh");
      assert.equal(journal[1]?.invocation, "resume");
      assert.equal(journal[1]?.resumeSession, "fixture-session");
      assert.deepEqual(journal[1]?.argv.slice(0, 2), ["exec", "resume"]);
      assert.equal(journal[1]?.argv.includes("--sandbox"), false);
      assert.equal(journal[1]?.argv.includes("--add-dir"), false);
      assert.equal(journal[0]?.stdin, prompt);
      assert.match(journal[1]?.stdin ?? "", /Continue the existing task from the current session state/u);
      assert.equal(journal.filter((entry) => entry.stdin.includes(prompt)).length, 1);
      assert.deepEqual(
        journal.map((entry) => entry.sentinel),
        ["mutation\n", "mutation\n"]
      );
      assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "mutation\n");
    };
    try {
      resetFixture("initial");
      const retryEvents: Record<string, unknown>[] = [];
      let retryStderr = "";
      const result = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Retry fixture",
        onEvent: (event) => {
          retryEvents.push(event);
          return Promise.reject(new Error("fixture callback rejection"));
        },
        onStderr: (text) => {
          retryStderr += text;
        }
      });
      assert.equal(result.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.match(retryStderr, /OpenRouter returned HTTP 429 before model output; retrying/u);
      assert.doesNotMatch(JSON.stringify(retryEvents), /fixture-1/u);
      assert.match(JSON.stringify(retryEvents), /fixture-2/u);
      assert.deepEqual(
        readOpenRouterRetryFixtureJournal(fixture.journal).map((entry) => entry.invocation),
        ["fresh", "fresh"]
      );

      for (const [mode, eventKind] of [
        ["substantive-command", "command"],
        ["substantive-message", "note"],
        ["substantive-reasoning", "reasoning"],
        ["substantive-file", "file_change"],
        ["substantive-tool", "tool"],
        ["substantive-web", "web_search"],
        ["substantive-todo", "todo_list"]
      ] as const) {
        resetFixture(mode);
        const prompt = `Do not replay ${eventKind} fixture`;
        const events: Record<string, unknown>[] = [];
        const recovered = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt,
          onEvent: (event) => events.push(event)
        });
        assert.equal(recovered.text, "OK", eventKind);
        assertExactResume(prompt);
        assert.match(JSON.stringify(events), new RegExp(`"kind":"${eventKind}"`, "u"), eventKind);
        assert.equal(events.filter((event) => event.type === "started").length, 1, eventKind);
        assert.equal(events.filter((event) => event.type === "completed" && event.ok === true).length, 1, eventKind);
        assert.equal(
          events.some((event) => event.type === "completed" && event.ok === false),
          false,
          eventKind
        );
        assert.doesNotMatch(JSON.stringify(events), /request id: fixture-1/u, eventKind);
      }

      resetFixture("substantive-stdout-only");
      const stdoutOnlyPrompt = "Resume stdout-only substantive progress without replay";
      const stdoutOnlyEvents: Record<string, unknown>[] = [];
      let stdoutOnlyText = "";
      const stdoutOnlyResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: stdoutOnlyPrompt,
        onEvent: (event) => stdoutOnlyEvents.push(event),
        onStdout: (text: string) => {
          stdoutOnlyText += text;
        }
      });
      assert.equal(stdoutOnlyResult.text, "OK");
      assertExactResume(stdoutOnlyPrompt);
      assert.equal((stdoutOnlyText.match(/stdout-only substantive progress/gu) ?? []).length, 1);
      assert.equal(stdoutOnlyEvents.filter((event) => event.type === "started").length, 1);

      resetFixture("substantive-stdout-replay", 7);
      let replayedStdoutText = "";
      const replayedStdoutResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Deduplicate replayed stdout across repeated recovery",
        onStdout: (text: string) => {
          replayedStdoutText += text;
        }
      });
      assert.equal(replayedStdoutResult.text, "OK");
      assert.equal((replayedStdoutText.match(/replayed stdout progress/gu) ?? []).length, 1);
      const replayedStdoutJournal = readOpenRouterRetryFixtureJournal(fixture.journal);
      assert.equal(replayedStdoutJournal.length, 8);
      assert.equal(replayedStdoutJournal.filter((entry) => entry.invocation === "fresh").length, 1);
      const replayedStdoutMarkers = replayedStdoutJournal.slice(1).map((entry) => {
        const marker = /OpenRouter transport recovery marker: ([0-9a-f-]+)\./u.exec(entry.stdin)?.[1];
        assert.ok(marker);
        return marker;
      });
      assert.equal(new Set(replayedStdoutMarkers).size, 1);

      resetFixture("substantive-command");
      const streamPrompt = "Resume the stream fixture without replay";
      const streamEvents: Record<string, unknown>[] = [];
      const streamResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).stream({
        prompt: streamPrompt,
        onEvent: (event) => streamEvents.push(event)
      });
      assert.equal(await streamResult.text, "OK");
      const streamedText = await streamResult.textStream.getReader().read();
      assert.deepEqual(streamedText, { value: "OK", done: false });
      assertExactResume(streamPrompt);
      assert.equal(streamEvents.filter((event) => event.type === "started").length, 1);
      assert.equal(
        streamEvents.some((event) => event.type === "completed" && event.ok === false),
        false
      );

      resetFixture("substantive-replay");
      const replayEvents: Record<string, unknown>[] = [];
      const replayResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Deduplicate replayed action fixture",
        onEvent: (event) => replayEvents.push(event)
      });
      assert.equal(replayResult.text, "OK");
      assert.equal((JSON.stringify(replayEvents).match(/"id":"message-1"/gu) ?? []).length, 1);

      resetFixture("substantive-updates");
      const updateEvents: Record<string, unknown>[] = [];
      const updateResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Preserve evolving action updates",
        onEvent: (event) => updateEvents.push(event)
      });
      assert.equal(updateResult.text, "OK");
      const updateStatuses = updateEvents
        .filter((event) => JSON.stringify(event).includes('"id":"update-1"'))
        .map((event) => (event.action as { detail?: { status?: unknown } }).detail?.status);
      assert.deepEqual(updateStatuses, ["in_progress", "completed"]);

      resetFixture("substantive-429-message");
      const substantive429Events: Record<string, unknown>[] = [];
      const substantive429Result = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Preserve a substantive message that mentions HTTP 429",
        onEvent: (event) => substantive429Events.push(event)
      });
      assert.equal(substantive429Result.text, "OK");
      assert.equal(
        substantive429Events.filter((event) => JSON.stringify(event).includes("Investigated HTTP 429 handling")).length,
        1
      );

      resetFixture("stderr-only");
      const stderrOnlyEvents: Record<string, unknown>[] = [];
      let stderrOnlyStderr = "";
      const stderrOnlyResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Recover a stderr-only rate limit",
        onEvent: (event) => stderrOnlyEvents.push(event),
        onStderr: (text) => {
          stderrOnlyStderr += text;
        }
      });
      assert.equal(stderrOnlyResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.equal(
        stderrOnlyEvents.some((event) => event.type === "completed" && event.ok === false),
        false
      );
      assert.doesNotMatch(stderrOnlyStderr, /request id: fixture-1/u);

      resetFixture("structured-429-partial-stderr");
      const classifiedPartialChunks: string[] = [];
      const classifiedPartialResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Do not release partial stderr while classifying a structured rate limit",
        onStderr: (text) => {
          classifiedPartialChunks.push(text);
        }
      });
      assert.equal(classifiedPartialResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.equal(classifiedPartialChunks.includes("HTT"), false);

      resetFixture("stderr-429-hang");
      let idleTimeoutRecoveryStderr = "";
      const idleTimeoutRecoveryResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Recover a latched stderr rate limit after the child idles",
        timeout: { idleMs: 100, totalMs: 2_000 },
        onStderr: (text) => {
          idleTimeoutRecoveryStderr += text;
        }
      });
      assert.equal(idleTimeoutRecoveryResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.doesNotMatch(idleTimeoutRecoveryStderr, /request id: fixture-1/u);

      for (const terminalMode of ["stderr-post-terminal", "stdout-post-terminal"] as const) {
        resetFixture(terminalMode);
        const postTerminalEvents: Record<string, unknown>[] = [];
        let postTerminalStdout = "";
        let postTerminalStderr = "";
        const postTerminalResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: `Quarantine ${terminalMode} trailing output`,
          onEvent: (event) => postTerminalEvents.push(event),
          onStdout: (text: string) => {
            postTerminalStdout += text;
          },
          onStderr: (text: string) => {
            postTerminalStderr += text;
          }
        });
        assert.equal(postTerminalResult.text, "OK");
        assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
        const postTerminalJournal = readOpenRouterRetryFixtureJournal(fixture.journal);
        assert.deepEqual(
          postTerminalJournal.map((entry) => entry.invocation),
          ["fresh", "resume"]
        );
        assert.equal(postTerminalJournal[1]?.resumeSession, "fixture-session");
        assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "post-terminal-observed-mutation\n");
        assert.doesNotMatch(JSON.stringify(postTerminalEvents), /post-terminal/u);
        assert.doesNotMatch(postTerminalStdout, /post-terminal/u);
        assert.doesNotMatch(postTerminalStderr, /post-terminal/u);
      }

      resetFixture("stderr-post-terminal");
      const noStderrCallbackEvents: Record<string, unknown>[] = [];
      let noStderrCallbackStdout = "";
      const noStderrCallbackResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Quarantine a stderr terminal without an onStderr callback",
        onEvent: (event) => noStderrCallbackEvents.push(event),
        onStdout: (text: string) => {
          noStderrCallbackStdout += text;
        }
      });
      assert.equal(noStderrCallbackResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.doesNotMatch(JSON.stringify(noStderrCallbackEvents), /post-terminal/u);
      assert.doesNotMatch(noStderrCallbackStdout, /post-terminal/u);

      resetFixture("stderr-provisional-post-terminal");
      const provisionalTerminalEvents: Record<string, unknown>[] = [];
      const provisionalTerminalProcessEvents: Array<{ phase: "started" | "exited"; pid: number | undefined }> = [];
      let provisionalTerminalStdout = "";
      const provisionalTerminalResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Quarantine cross-channel output while a stderr terminal is provisional",
        onEvent: (event) => provisionalTerminalEvents.push(event),
        onProcess: (event: { phase: "started" | "exited"; pid: number | undefined }) =>
          provisionalTerminalProcessEvents.push(event),
        onStdout: (text: string) => {
          provisionalTerminalStdout += text;
        }
      });
      assert.equal(provisionalTerminalResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.deepEqual(
        readOpenRouterRetryFixtureJournal(fixture.journal).map((entry) => entry.invocation),
        ["fresh", "resume"]
      );
      assert.equal(fs.readFileSync(fixture.provisionalAck, "utf8"), "observed\n");
      assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "provisional-post-terminal-mutation\n");
      assert.doesNotMatch(JSON.stringify(provisionalTerminalEvents), /provisional-post-terminal/u);
      assert.doesNotMatch(provisionalTerminalStdout, /provisional post-terminal/u);
      assert.equal(provisionalTerminalProcessEvents.filter((event) => event.phase === "started").length, 2);
      assert.equal(provisionalTerminalProcessEvents.filter((event) => event.phase === "exited").length, 1);

      for (const boundaryMode of [
        "stderr-left-boundary-negative",
        "stderr-right-boundary-negative",
        "stderr-long-s-boundary-negative"
      ] as const) {
        resetFixture(boundaryMode, 0);
        const boundaryEvents: Record<string, unknown>[] = [];
        let boundaryStderr = "";
        let boundaryStdout = "";
        const boundaryResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: `Do not latch ${boundaryMode}`,
          onEvent: (event) => boundaryEvents.push(event),
          onStdout: (text: string) => {
            boundaryStdout += text;
          },
          onStderr: (text) => {
            boundaryStderr += text;
          }
        });
        assert.equal(boundaryResult.text, "OK", boundaryMode);
        assert.equal(fs.readFileSync(fixture.counter, "utf8"), "1", boundaryMode);
        assert.match(boundaryStderr, /prefixHTTP 429 suffix|HTTP 429suffix|HTTP ſtatus 429suffix/u, boundaryMode);
        assert.equal(
          boundaryEvents.some((event) => event.type === "completed" && event.ok === true),
          true,
          boundaryMode
        );
        if (boundaryMode !== "stderr-left-boundary-negative") {
          assert.match(boundaryStdout, new RegExp(boundaryMode + " boundary disproved", "u"));
          assert.match(JSON.stringify(boundaryEvents), new RegExp(boundaryMode + " event preserved", "u"));
          const lifecycleStartedIndex = boundaryEvents.findIndex((event) => event.type === "started");
          const lifecycleTurnIndex = boundaryEvents.findIndex(
            (event) => event.type === "action" && (event.action as { kind?: unknown }).kind === "turn"
          );
          const provisionalEventIndex = boundaryEvents.findIndex((event) =>
            JSON.stringify(event).includes(boundaryMode + " event preserved")
          );
          assert.equal(lifecycleStartedIndex >= 0, true);
          assert.equal(lifecycleTurnIndex > lifecycleStartedIndex, true);
          assert.equal(provisionalEventIndex > lifecycleTurnIndex, true);
        }
      }

      resetFixture("stderr-oversized");
      let oversizedRetryStderr = "";
      const oversizedRetryResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Quarantine an oversized unterminated rate limit",
        onStderr: (text) => {
          oversizedRetryStderr += text;
        }
      });
      assert.equal(oversizedRetryResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.doesNotMatch(oversizedRetryStderr, /request id: fixture-1/u);

      resetFixture("stderr-character-split");
      let characterSplitStderr = "";
      const characterSplitResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Quarantine a character-split multiline rate limit",
        onStderr: (text) => {
          characterSplitStderr += text;
        }
      });
      assert.equal(characterSplitResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.doesNotMatch(characterSplitStderr, /request id: fixture-1/u);

      resetFixture("stderr-unicode-prefix-split");
      let unicodePrefixStderr = "";
      const unicodePrefixResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Preserve source indexes across a Unicode prefix",
        onStderr: (text) => {
          unicodePrefixStderr += text;
        }
      });
      assert.equal(unicodePrefixResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.doesNotMatch(unicodePrefixStderr, /request id: fixture-1/u);

      resetFixture("warning-burst", 0);
      const warningBurstEvents: Record<string, unknown>[] = [];
      let warningBurstStderr = "";
      const warningBurstResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Bound pre-substantive warning retention",
        onEvent: (event) => warningBurstEvents.push(event),
        onStderr: (text) => {
          warningBurstStderr += text;
          if (!warningBurstStderr.includes("ordinary warning 255")) return;
          // The underlying adapter parses warning events after invoking its
          // raw stderr callback. A microtask acknowledges only after that
          // synchronous parser has staged the complete burst.
          queueMicrotask(() => fs.writeFileSync(fixture.warningAck, "observed\n", "utf8"));
        }
      });
      assert.equal(warningBurstResult.text, "OK");
      assert.equal(
        warningBurstEvents.filter(
          (event) => event.type === "action" && (event.action as { kind?: unknown }).kind === "warning"
        ).length,
        1
      );
      assert.match(JSON.stringify(warningBurstEvents), /ordinary warning 255/u);

      resetFixture("missing-session");
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({ prompt: "Missing session fixture" }),
        /429 Too Many Requests/u
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "1");
      assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "mutation\n");

      resetFixture("missing-session");
      const explicitResume = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Continue an explicit known session",
        resumeSession: "fixture-session"
      });
      assert.equal(explicitResume.text, "OK");
      assert.deepEqual(
        readOpenRouterRetryFixtureJournal(fixture.journal).map((entry) => entry.invocation),
        ["resume", "resume"]
      );

      resetFixture("fresh-conflicting-session");
      const freshConflictEvents: Record<string, unknown>[] = [];
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Fresh session conflict fixture",
          onEvent: (event) => freshConflictEvents.push(event)
        }),
        /returned session conflicting-session, expected fixture-session/u
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "1");
      assert.doesNotMatch(JSON.stringify(freshConflictEvents), /conflicting-session/u);

      resetFixture("conflicting-session");
      const conflictEvents: Record<string, unknown>[] = [];
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Conflicting session fixture",
          onEvent: (event) => conflictEvents.push(event)
        }),
        /returned session conflicting-session, expected fixture-session/u
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.doesNotMatch(JSON.stringify(conflictEvents), /"answer":"OK"|"text":"OK"/u);

      resetFixture("late-conflicting-session");
      const lateConflictEvents: Record<string, unknown>[] = [];
      let lateConflictStdout = "";
      let lateConflictStderr = "";
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Late session conflict fixture",
          onEvent: (event) => lateConflictEvents.push(event),
          onStdout: (text: string) => {
            lateConflictStdout += text;
          },
          onStderr: (text) => {
            lateConflictStderr += text;
          }
        }),
        /returned session conflicting-session, expected fixture-session/u
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.match(JSON.stringify(lateConflictEvents), /before conflict/u);
      assert.doesNotMatch(JSON.stringify(lateConflictEvents), /must stay quarantined|"answer":"OK"|"text":"OK"/u);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "mutation\n");
      assert.doesNotMatch(lateConflictStdout, /must stay quarantined|WRONG/u);
      assert.doesNotMatch(lateConflictStderr, /must stay quarantined/u);

      resetFixture("unrelated");
      let unrelatedStderr = "";
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Unrelated numeric error fixture",
          onStderr: (text) => {
            unrelatedStderr += text;
          }
        }),
        /job-429/u
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "1");
      assert.doesNotMatch(unrelatedStderr, /retrying|resuming/u);

      resetFixture("empty-success");
      let callbackStderr = "";
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Successful empty turn callback fixture",
          onEvent: () => {
            throw new Error("HTTP 429 from caller callback");
          },
          onStderr: (text) => {
            callbackStderr += text;
          }
        }),
        /HTTP 429 from caller callback/u
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "1");
      assert.doesNotMatch(callbackStderr, /retrying|resuming/u);

      resetFixture("callback-hang");
      let processCallbackStderr = "";
      const processCallbackStartedAt = performance.now();
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Successful process callback fixture",
          onProcess: () => {
            throw new Error("HTTP 429 from caller process callback");
          },
          onStderr: (text) => {
            processCallbackStderr += text;
          }
        }),
        /HTTP 429 from caller process callback/u
      );
      assert.equal(performance.now() - processCallbackStartedAt < 400, true);
      assert.equal(Number(fs.readFileSync(fixture.counter, "utf8")) <= 1, true);
      assert.doesNotMatch(processCallbackStderr, /retrying|resuming/u);

      resetFixture("stdout-callback-hang");
      const stdoutCallbackStartedAt = performance.now();
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Stop a hanging process from stdout",
          onStdout: (_text: string) => {
            throw new Error("caller stdout callback stopped process");
          }
        }),
        /caller stdout callback stopped process/u
      );
      assert.equal(performance.now() - stdoutCallbackStartedAt < 400, true);
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "1");

      resetFixture("stderr-callback-hang");
      const stderrCallbackStartedAt = performance.now();
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Stop a hanging process from stderr",
          onStderr: () => {
            throw new Error("caller stderr callback stopped process");
          }
        }),
        /caller stderr callback stopped process/u
      );
      assert.equal(performance.now() - stderrCallbackStartedAt < 400, true);
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "1");

      resetFixture("initial", 0);
      let rejectedWithUndefined = false;
      try {
        await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Caller throws undefined",
          onEvent: () => {
            throw undefined;
          }
        });
      } catch (error) {
        rejectedWithUndefined = true;
        assert.equal(error, undefined);
      }
      assert.equal(rejectedWithUndefined, true);
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "1");

      resetFixture("substantive-command");
      let substantiveCallbackStderr = "";
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Substantive caller callback fixture",
          onEvent: (event) => {
            if (JSON.stringify(event).includes('"kind":"command"')) {
              throw new Error("HTTP 429 from substantive caller callback");
            }
          },
          onStderr: (text) => {
            substantiveCallbackStderr += text;
          }
        }),
        /HTTP 429 from substantive caller callback/u
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "1");
      assert.doesNotMatch(substantiveCallbackStderr, /retrying|resuming/u);

      resetFixture("resume-hang");
      const hangingCallbackStartedAt = performance.now();
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Stop a resumed process after a callback failure",
          onEvent: (event) => {
            if (JSON.stringify(event).includes("resume began")) {
              throw new Error("caller callback stopped resumed process");
            }
          }
        }),
        /caller callback stopped resumed process/u
      );
      assert.equal(performance.now() - hangingCallbackStartedAt < 1_000, true);
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");

      resetFixture("initial");
      const preAbortedController = new AbortController();
      preAbortedController.abort(new Error("fixture pre-aborted"));
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Pre-aborted fixture",
          abortSignal: preAbortedController.signal
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, "PROCESS_ABORTED");
          return true;
        }
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "0");

      const backoffController = new AbortController();
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Abort backoff fixture",
          abortSignal: backoffController.signal,
          onStderr: (text) => {
            if (text.includes("OpenRouter returned HTTP 429")) {
              backoffController.abort(new Error("fixture cancelled during backoff"));
            }
          }
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, "PROCESS_ABORTED");
          assert.match(String(error), /OpenRouter retry aborted during HTTP 429 recovery/u);
          return true;
        }
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "1");

      resetFixture("resume-hang");
      const resumeController = new AbortController();
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Abort resumed process fixture",
          abortSignal: resumeController.signal,
          onEvent: (event) => {
            if (JSON.stringify(event).includes("resume began")) {
              resumeController.abort(new Error("fixture cancelled inside resume"));
            }
          }
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, "PROCESS_ABORTED");
          return true;
        }
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");

      resetFixture("resume-hang");
      const timeoutStartedAt = performance.now();
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Bounded resume timeout fixture",
          timeout: 250
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, "PROCESS_TIMEOUT");
          return true;
        }
      );
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.equal(performance.now() - timeoutStartedAt < 1_000, true);
    } finally {
      for (const [name, value] of Object.entries({
        ULTRAFUZZ_CONFIG_PATH: previous.config,
        OPENROUTER_API_KEY: previous.key,
        PATH: previous.path,
        OPENROUTER_RETRY_FIXTURE_COUNTER: previous.counter,
        OPENROUTER_RETRY_FIXTURE_JOURNAL: previous.journal,
        OPENROUTER_RETRY_FIXTURE_SENTINEL: previous.sentinel,
        OPENROUTER_RETRY_FIXTURE_PROVISIONAL_ACK: previous.provisionalAck,
        OPENROUTER_RETRY_FIXTURE_WARNING_ACK: previous.warningAck,
        OPENROUTER_RETRY_FIXTURE_MODE: previous.mode,
        OPENROUTER_RETRY_FIXTURE_FAILURES: previous.failures
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
);

bunAdapterTest(
  "generated OpenRouter adapter resumes generate and stream through seven same-session 429s",
  { timeout: 20_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const configPath = path.join(project, "ultrafuzz.toml");
    const fixture = installOpenRouterRetryCodexFixture(project);
    const { createOpenRouterAgent } = await loadGeneratedOpenRouterAgent(project, {
      retryWindowMs: 5_000,
      initialDelayMs: 1,
      maxDelayMs: 2,
      jitterFraction: 0
    });
    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      key: process.env.OPENROUTER_API_KEY,
      path: process.env.PATH,
      counter: process.env.OPENROUTER_RETRY_FIXTURE_COUNTER,
      journal: process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL,
      sentinel: process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL,
      mode: process.env.OPENROUTER_RETRY_FIXTURE_MODE,
      failures: process.env.OPENROUTER_RETRY_FIXTURE_FAILURES
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.OPENROUTER_API_KEY = "deterministic-openrouter-test-key";
    process.env.PATH = `${fixture.bin}${path.delimiter}${previous.path ?? ""}`;
    process.env.OPENROUTER_RETRY_FIXTURE_COUNTER = fixture.counter;
    process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL = fixture.journal;
    process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL = fixture.sentinel;
    process.env.OPENROUTER_RETRY_FIXTURE_MODE = "substantive-command";
    process.env.OPENROUTER_RETRY_FIXTURE_FAILURES = "7";
    try {
      const longRetryEvents: Record<string, unknown>[] = [];
      const result = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
        prompt: "Recover after seven same-session rate limits",
        onEvent: (event) => longRetryEvents.push(event)
      });
      assert.equal(result.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "8");
      assert.equal(longRetryEvents.filter((event) => event.type === "started").length, 1);
      assert.equal(
        longRetryEvents.some((event) => event.type === "completed" && event.ok === false),
        false
      );
      assert.doesNotMatch(JSON.stringify(longRetryEvents), /request id: fixture-[1-7]/u);
      const generateJournal = readOpenRouterRetryFixtureJournal(fixture.journal);
      const generatePrompt = "Recover after seven same-session rate limits";
      assert.deepEqual(
        generateJournal.map((entry) => entry.invocation),
        ["fresh", "resume", "resume", "resume", "resume", "resume", "resume", "resume"]
      );
      assert.equal(
        generateJournal.slice(1).every((entry) => entry.resumeSession === "fixture-session"),
        true
      );
      assert.equal(generateJournal.filter((entry) => entry.stdin.includes(generatePrompt)).length, 1);
      const generateRecoveryMarkers = generateJournal.slice(1).map((entry) => {
        const marker = /OpenRouter transport recovery marker: ([0-9a-f-]+)\./u.exec(entry.stdin)?.[1];
        assert.ok(marker);
        return marker;
      });
      assert.equal(new Set(generateRecoveryMarkers).size, 1);
      assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "mutation\n");

      fs.writeFileSync(fixture.counter, "0", "utf8");
      fs.writeFileSync(fixture.journal, "", "utf8");
      fs.rmSync(fixture.sentinel, { force: true });
      const streamResult = await createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).stream({
        prompt: "Stream after seven same-session rate limits"
      });
      assert.equal(await streamResult.text, "OK");
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "8");
      const streamJournal = readOpenRouterRetryFixtureJournal(fixture.journal);
      const streamPrompt = "Stream after seven same-session rate limits";
      assert.equal(streamJournal.filter((entry) => entry.invocation === "fresh").length, 1);
      assert.equal(streamJournal.filter((entry) => entry.invocation === "resume").length, 7);
      assert.equal(
        streamJournal.slice(1).every((entry) => entry.resumeSession === "fixture-session"),
        true
      );
      assert.equal(streamJournal.filter((entry) => entry.stdin.includes(streamPrompt)).length, 1);
      const streamRecoveryMarkers = streamJournal.slice(1).map((entry) => {
        const marker = /OpenRouter transport recovery marker: ([0-9a-f-]+)\./u.exec(entry.stdin)?.[1];
        assert.ok(marker);
        return marker;
      });
      assert.equal(new Set(streamRecoveryMarkers).size, 1);
      assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "mutation\n");
    } finally {
      for (const [name, value] of Object.entries({
        ULTRAFUZZ_CONFIG_PATH: previous.config,
        OPENROUTER_API_KEY: previous.key,
        PATH: previous.path,
        OPENROUTER_RETRY_FIXTURE_COUNTER: previous.counter,
        OPENROUTER_RETRY_FIXTURE_JOURNAL: previous.journal,
        OPENROUTER_RETRY_FIXTURE_SENTINEL: previous.sentinel,
        OPENROUTER_RETRY_FIXTURE_MODE: previous.mode,
        OPENROUTER_RETRY_FIXTURE_FAILURES: previous.failures
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
);

bunAdapterTest(
  "generated OpenRouter adapter rethrows the last 429 without starting an attempt at its retry deadline",
  { timeout: 20_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const configPath = path.join(project, "ultrafuzz.toml");
    const fixture = installOpenRouterRetryCodexFixture(project);
    const { createOpenRouterAgent } = await loadGeneratedOpenRouterAgent(project, {
      retryWindowMs: 1_000,
      initialDelayMs: 100,
      maxDelayMs: 100,
      jitterFraction: 0
    });
    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      key: process.env.OPENROUTER_API_KEY,
      path: process.env.PATH,
      counter: process.env.OPENROUTER_RETRY_FIXTURE_COUNTER,
      journal: process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL,
      sentinel: process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL,
      mode: process.env.OPENROUTER_RETRY_FIXTURE_MODE,
      failures: process.env.OPENROUTER_RETRY_FIXTURE_FAILURES
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.OPENROUTER_API_KEY = "deterministic-openrouter-test-key";
    process.env.PATH = `${fixture.bin}${path.delimiter}${previous.path ?? ""}`;
    process.env.OPENROUTER_RETRY_FIXTURE_COUNTER = fixture.counter;
    process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL = fixture.journal;
    process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL = fixture.sentinel;
    process.env.OPENROUTER_RETRY_FIXTURE_MODE = "substantive-command";
    process.env.OPENROUTER_RETRY_FIXTURE_FAILURES = "100";
    try {
      const finalEvents: Record<string, unknown>[] = [];
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Exhaust the bounded same-session recovery window",
          onEvent: (event) => finalEvents.push(event)
        }),
        (error: unknown) => {
          const finalAttempt = Number(fs.readFileSync(fixture.counter, "utf8"));
          assert.equal(finalAttempt > 1, true);
          assert.match(String(error), new RegExp(`request id: fixture-${finalAttempt}\\b`, "u"));
          const finalEventText = JSON.stringify(finalEvents);
          for (let attempt = 1; attempt < finalAttempt; attempt += 1) {
            assert.doesNotMatch(finalEventText, new RegExp(`request id: fixture-${attempt}\\b`, "u"));
          }
          assert.match(finalEventText, new RegExp(`request id: fixture-${finalAttempt}\\b`, "u"));
          return true;
        }
      );
      const journal = readOpenRouterRetryFixtureJournal(fixture.journal);
      assert.equal(journal[0]?.invocation, "fresh");
      assert.equal(
        journal.slice(1).every((entry) => entry.invocation === "resume"),
        true
      );
      assert.equal(
        journal.slice(1).every((entry) => entry.resumeSession === "fixture-session"),
        true
      );
      assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "mutation\n");
      const settledAttemptCount = fs.readFileSync(fixture.counter, "utf8");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), settledAttemptCount);

      fs.writeFileSync(fixture.counter, "0", "utf8");
      fs.writeFileSync(fixture.journal, "", "utf8");
      fs.rmSync(fixture.sentinel, { force: true });
      process.env.OPENROUTER_RETRY_FIXTURE_MODE = "stderr-only";
      let finalStderr = "";
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Expose only the final exhausted stderr rate limit",
          onStderr: (text) => {
            finalStderr += text;
          }
        }),
        /429 Too Many Requests/u
      );
      const finalStderrAttempt = Number(fs.readFileSync(fixture.counter, "utf8"));
      assert.equal(finalStderrAttempt > 1, true);
      for (let attempt = 1; attempt < finalStderrAttempt; attempt += 1) {
        assert.doesNotMatch(finalStderr, new RegExp(`request id: fixture-${attempt}\\b`, "u"));
      }
      assert.equal(
        (finalStderr.match(new RegExp(`request id: fixture-${finalStderrAttempt}\\b`, "gu")) ?? []).length,
        1
      );

      fs.writeFileSync(fixture.counter, "0", "utf8");
      fs.writeFileSync(fixture.journal, "", "utf8");
      process.env.OPENROUTER_RETRY_FIXTURE_MODE = "stderr-oversized";
      let finalOversizedStderr = "";
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Retain one bounded oversized final diagnostic",
          onStderr: (text) => {
            finalOversizedStderr += text;
          }
        }),
        /429 Too Many Requests/u
      );
      const finalOversizedAttempt = Number(fs.readFileSync(fixture.counter, "utf8"));
      assert.equal(finalOversizedAttempt > 1, true);
      for (let attempt = 1; attempt < finalOversizedAttempt; attempt += 1) {
        assert.doesNotMatch(finalOversizedStderr, new RegExp(`request id: fixture-${attempt}\\b`, "u"));
      }
      assert.equal(
        (finalOversizedStderr.match(new RegExp(`request id: fixture-${finalOversizedAttempt}\\b`, "gu")) ?? []).length,
        1
      );
      assert.equal(finalOversizedStderr.length <= OPENROUTER_TEST_STDERR_PENDING_LIMIT * 2, true);

      fs.writeFileSync(fixture.counter, "0", "utf8");
      fs.writeFileSync(fixture.journal, "", "utf8");
      process.env.OPENROUTER_RETRY_FIXTURE_MODE = "stderr-429-hang";
      process.env.OPENROUTER_RETRY_FIXTURE_FAILURES = "100";
      let idleExhaustionStderr = "";
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Preserve the provider 429 when idle-timeout recovery exhausts",
          // The idle clock includes the watchdog and fixture process startup.
          // Leave enough launch headroom that this exercises a child which
          // emitted a 429 and then went idle, not a pre-output startup timeout.
          timeout: { idleMs: 500, totalMs: 5_000 },
          onStderr: (text) => {
            idleExhaustionStderr += text;
          }
        }),
        /HTTP 429 request id: fixture-/u
      );
      const idleExhaustionAttempts = Number(fs.readFileSync(fixture.counter, "utf8"));
      assert.equal(idleExhaustionAttempts > 1 && idleExhaustionAttempts < 100, true);
      assert.match(idleExhaustionStderr, new RegExp("request id: fixture-" + String(idleExhaustionAttempts), "u"));

      fs.writeFileSync(fixture.counter, "0", "utf8");
      fs.writeFileSync(fixture.journal, "", "utf8");
      fs.rmSync(fixture.sentinel, { force: true });
      process.env.OPENROUTER_RETRY_FIXTURE_FAILURES = "100";
      process.env.OPENROUTER_RETRY_FIXTURE_MODE = "stdout-post-terminal";
      const finalReleaseOrder: string[] = [];
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Release final trailing evidence before completion",
          onStdout: (text: string) => {
            if (text.includes("post-terminal")) finalReleaseOrder.push("stdout");
          },
          onStderr: (text: string) => {
            if (text.includes("post-terminal")) finalReleaseOrder.push("stderr");
          },
          onEvent: (event) => {
            if (JSON.stringify(event).includes("post-terminal")) finalReleaseOrder.push("event");
            if (event.type === "completed") finalReleaseOrder.push("completion");
          }
        }),
        /429 Too Many Requests/u
      );
      assert.equal(finalReleaseOrder.includes("stdout"), true);
      assert.equal(finalReleaseOrder.includes("stderr"), true);
      assert.equal(finalReleaseOrder.includes("event"), true);
      assert.equal(finalReleaseOrder.at(-1), "completion");
    } finally {
      for (const [name, value] of Object.entries({
        ULTRAFUZZ_CONFIG_PATH: previous.config,
        OPENROUTER_API_KEY: previous.key,
        PATH: previous.path,
        OPENROUTER_RETRY_FIXTURE_COUNTER: previous.counter,
        OPENROUTER_RETRY_FIXTURE_JOURNAL: previous.journal,
        OPENROUTER_RETRY_FIXTURE_SENTINEL: previous.sentinel,
        OPENROUTER_RETRY_FIXTURE_MODE: previous.mode,
        OPENROUTER_RETRY_FIXTURE_FAILURES: previous.failures
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
);

bunAdapterTest(
  "generated OpenRouter adapter retains the last real 429 when a replacement build crosses the retry deadline",
  { timeout: 20_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const configPath = path.join(project, "ultrafuzz.toml");
    const fixture = installOpenRouterRetryCodexFixture(project);
    const { createOpenRouterAgent } = await loadGeneratedOpenRouterAgent(
      project,
      {
        retryWindowMs: 5_000,
        initialDelayMs: 1,
        maxDelayMs: 1,
        jitterFraction: 0
      },
      { expireRetryDeadlineBeforeReplacementBuild: 2 }
    );
    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      key: process.env.OPENROUTER_API_KEY,
      path: process.env.PATH,
      counter: process.env.OPENROUTER_RETRY_FIXTURE_COUNTER,
      journal: process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL,
      sentinel: process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL,
      mode: process.env.OPENROUTER_RETRY_FIXTURE_MODE,
      failures: process.env.OPENROUTER_RETRY_FIXTURE_FAILURES
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = configPath;
    process.env.OPENROUTER_API_KEY = "deterministic-openrouter-test-key";
    process.env.PATH = `${fixture.bin}${path.delimiter}${previous.path ?? ""}`;
    process.env.OPENROUTER_RETRY_FIXTURE_COUNTER = fixture.counter;
    process.env.OPENROUTER_RETRY_FIXTURE_JOURNAL = fixture.journal;
    process.env.OPENROUTER_RETRY_FIXTURE_SENTINEL = fixture.sentinel;
    process.env.OPENROUTER_RETRY_FIXTURE_MODE = "stderr-oversized";
    process.env.OPENROUTER_RETRY_FIXTURE_FAILURES = "100";
    try {
      let finalStderr = "";
      await assert.rejects(
        createOpenRouterAgent({ model: "openai/gpt-5.6-luna" }).generate({
          prompt: "Cross the retry deadline after deciding to replace the final real attempt",
          onStderr: (text) => {
            finalStderr += text;
          }
        }),
        (error: unknown) => {
          assert.match(String(error), /request id: fixture-2\b/u);
          return true;
        }
      );

      // Two provider children ran. The instrumented third replacement crossed
      // its deadline inside buildCommand, before it could increment the child
      // fixture counter or append a journal entry.
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
      assert.equal(readOpenRouterRetryFixtureJournal(fixture.journal).length, 2);
      assert.doesNotMatch(finalStderr, /request id: fixture-1\b/u);
      assert.equal((finalStderr.match(/request id: fixture-2\b/gu) ?? []).length, 1);
      assert.doesNotMatch(finalStderr, /request id: fixture-3\b/u);
      assert.equal(finalStderr.length <= OPENROUTER_TEST_STDERR_PENDING_LIMIT * 2, true);

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      assert.equal(fs.readFileSync(fixture.counter, "utf8"), "2");
    } finally {
      for (const [name, value] of Object.entries({
        ULTRAFUZZ_CONFIG_PATH: previous.config,
        OPENROUTER_API_KEY: previous.key,
        PATH: previous.path,
        OPENROUTER_RETRY_FIXTURE_COUNTER: previous.counter,
        OPENROUTER_RETRY_FIXTURE_JOURNAL: previous.journal,
        OPENROUTER_RETRY_FIXTURE_SENTINEL: previous.sentinel,
        OPENROUTER_RETRY_FIXTURE_MODE: previous.mode,
        OPENROUTER_RETRY_FIXTURE_FAILURES: previous.failures
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
);

bunAdapterTest(
  "generated OpenRouter adapter fails before materializing config when its dedicated key is missing",
  { timeout: 30_000 },
  async () => {
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
  }
);

bunAdapterTest(
  "generated agents cannot relabel an aliased execution-snapshot path as a credential",
  { timeout: 30_000 },
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
      ULTRAFUZZ_SNAPSHOT_SOURCE_ROOT: snapshotRoot,
      ULTRAFUZZ_PROVIDER_HOME_ROOT: path.join(project, "operator-provider-homes"),
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
        ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT: `/proc/${process.pid}/fd/19`,
        ULTRAFUZZ_SNAPSHOT_SOURCE_ROOT: snapshotRoot
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
      "ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT",
      "ULTRAFUZZ_SNAPSHOT_SOURCE_ROOT",
      "ULTRAFUZZ_PROVIDER_HOME_ROOT"
    ]) {
      assert.equal(sanitized[name], "", `${name} escaped into a model child environment`);
    }

    const providerScoped = workflowControlChildEnvironment(
      {
        OPENAI_API_KEY: "active-openai-key",
        CUSTOM_ACTIVE_KEY: "active-custom-key",
        CODEX_HOME: "/operator/codex"
      },
      {
        OPENAI_API_KEY: "ambient-openai-key",
        ANTHROPIC_API_KEY: "ambient-anthropic-key",
        DEEPSEEK_API_KEY: "ambient-deepseek-key",
        OPENROUTER_API_KEY: "ambient-openrouter-key",
        CUSTOM_PROVIDER_KEY: "ambient-custom-key",
        CLAUDE_CONFIG_DIR: "/operator/claude",
        KIMI_CODE_HOME: "/operator/kimi",
        ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES:
          "OPENAI_API_KEY,ANTHROPIC_API_KEY,DEEPSEEK_API_KEY,OPENROUTER_API_KEY,CUSTOM_PROVIDER_KEY,CUSTOM_ACTIVE_KEY"
      }
    );
    assert.equal(providerScoped.OPENAI_API_KEY, "active-openai-key");
    assert.equal(providerScoped.CUSTOM_ACTIVE_KEY, "active-custom-key");
    assert.equal(providerScoped.CODEX_HOME, "/operator/codex");
    for (const name of [
      "ANTHROPIC_API_KEY",
      "DEEPSEEK_API_KEY",
      "OPENROUTER_API_KEY",
      "CUSTOM_PROVIDER_KEY",
      "CLAUDE_CONFIG_DIR",
      "KIMI_CODE_HOME"
    ]) {
      assert.equal(providerScoped[name], "", `${name} leaked into the OpenAI child`);
    }
    assert.equal(providerScoped.ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES, "");

    const allowlistedSource = linkedWorkflowExecutionEnvironment(
      { executionSnapshot: { env: {} } } as never,
      {
        ULTRAFUZZ_AGENT_ENV_ALLOWLIST:
          "AWS_ACCESS_KEY_ID,AWS_CUSTOM_TOKEN,AWS_SESSION_TOKEN,aws_case_token,CUSTOM_AUTH,CUSTOM_SHARED_TOKEN,DATABASE_PASSWD,FOUNDRY_PROFILE,MAINNET_RPC_URL,SSH_PRIVATE_KEY",
        AWS_ACCESS_KEY_ID: "AKIA0123456789ABCDEF",
        AWS_CUSTOM_TOKEN: "configured-for-codex",
        AWS_SESSION_TOKEN: "claude-route-token",
        aws_case_token: "case-variant-claude-token",
        CUSTOM_AUTH: "custom-auth-secret",
        CUSTOM_SHARED_TOKEN: "must-not-cross-provider-boundaries",
        DATABASE_PASSWD: "database-password",
        FOUNDRY_PROFILE: "ci",
        MAINNET_RPC_URL: `https://eth-mainnet.g.alchemy.com/v2/${"a".repeat(32)}`,
        SSH_PRIVATE_KEY: "private-key"
      },
      ["aws_custom_token"]
    );
    assert.ok(allowlistedSource.ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES?.split(",").includes("MAINNET_RPC_URL"));
    const codexAllowlisted = {
      ...allowlistedSource,
      ...workflowControlChildEnvironment({}, allowlistedSource, { agent: "CodexAgent" })
    };
    assert.equal(codexAllowlisted.AWS_ACCESS_KEY_ID, "");
    assert.equal(codexAllowlisted.AWS_CUSTOM_TOKEN, "");
    assert.equal(codexAllowlisted.AWS_SESSION_TOKEN, "");
    assert.equal(codexAllowlisted.aws_case_token, "");
    assert.equal(codexAllowlisted.CUSTOM_AUTH, "");
    assert.equal(codexAllowlisted.CUSTOM_SHARED_TOKEN, "");
    assert.equal(codexAllowlisted.DATABASE_PASSWD, "");
    assert.equal(codexAllowlisted.MAINNET_RPC_URL, "");
    assert.equal(codexAllowlisted.SSH_PRIVATE_KEY, "");
    assert.equal(codexAllowlisted.FOUNDRY_PROFILE, "ci");
    assert.equal(codexAllowlisted.ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES, "");
    const claudeAllowlisted = {
      ...allowlistedSource,
      ...workflowControlChildEnvironment({ AWS_ACCESS_KEY_ID: "", AWS_SESSION_TOKEN: "" }, allowlistedSource, {
        agent: "ClaudeAgent"
      })
    };
    assert.equal(claudeAllowlisted.AWS_ACCESS_KEY_ID, "AKIA0123456789ABCDEF");
    assert.equal(claudeAllowlisted.AWS_CUSTOM_TOKEN, "");
    assert.equal(claudeAllowlisted.AWS_SESSION_TOKEN, "claude-route-token");
    assert.equal(claudeAllowlisted.aws_case_token, "case-variant-claude-token");
    assert.equal(claudeAllowlisted.CUSTOM_AUTH, "");
    assert.equal(claudeAllowlisted.CUSTOM_SHARED_TOKEN, "");
    assert.equal(claudeAllowlisted.DATABASE_PASSWD, "");
    assert.equal(claudeAllowlisted.MAINNET_RPC_URL, "");
    assert.equal(claudeAllowlisted.SSH_PRIVATE_KEY, "");
    assert.equal(claudeAllowlisted.FOUNDRY_PROFILE, "ci");
    assert.equal(claudeAllowlisted.ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES, "");
    const explicitlyRestored = {
      ...allowlistedSource,
      ...workflowControlChildEnvironment({ CUSTOM_SHARED_TOKEN: "configured-active-token" }, allowlistedSource, {
        agent: "CodexAgent"
      })
    };
    assert.equal(explicitlyRestored.CUSTOM_SHARED_TOKEN, "configured-active-token");
    const configuredCodexCredential = {
      ...allowlistedSource,
      ...workflowControlChildEnvironment({ AWS_CUSTOM_TOKEN: "configured-for-codex" }, allowlistedSource, {
        agent: "CodexAgent"
      })
    };
    assert.equal(configuredCodexCredential.AWS_CUSTOM_TOKEN, "configured-for-codex");
    assert.throws(
      () => workflowControlChildEnvironment({}, { ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES: "NOT-AN-ENV" }),
      /provider credential environment list is invalid/u
    );

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

bunAdapterTest(
  "generated DeepSeek adapter uses the official endpoint and preserves independent usage components",
  { timeout: 30_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { CompatibleClaudeCodeAgent, DeepSeekClaudeCodeAgent } = await loadGeneratedDeepSeekAgent(project);
    fs.mkdirSync(path.join(project, ".claude"));
    fs.writeFileSync(
      path.join(project, ".claude", "settings.json"),
      '{"env":{"ANTHROPIC_BASE_URL":"https://target.invalid"}}'
    );
    fs.writeFileSync(path.join(project, ".claude", "settings.local.json"), '{"permissions":{"allow":["Bash(*)"]}}');
    const agent = new DeepSeekClaudeCodeAgent({
      model: "deepseek-v4-pro",
      effort: "max",
      permissionMode: "bypassPermissions",
      ultrafuzzApiKey: "deepseek-test-key",
      configDir: path.join(project, ".ultrafuzz", "deepseek-claude")
    });

    const command = await agent.buildCommand({ prompt: "Contract only", cwd: project, options: {} });
    try {
      assert.equal(command.command, "claude");
      assert.equal(command.args.includes("deepseek-v4-pro"), true);
      const claude = new CompatibleClaudeCodeAgent({ permissionMode: "bypassPermissions", settingSources: "project" });
      const claudeCommand = await claude.buildCommand({ prompt: "Contract only", cwd: project, options: {} });
      assert.deepEqual(
        command.args.flatMap((value, index) =>
          value === "--setting-sources" ? command.args.slice(index, index + 2) : []
        ),
        ["--setting-sources", ""]
      );
      assert.deepEqual(
        claudeCommand.args.flatMap((value, index) =>
          value === "--setting-sources" ? claudeCommand.args.slice(index, index + 2) : []
        ),
        ["--setting-sources", "user"]
      );
      for (const args of [command.args, claudeCommand.args]) {
        assert.equal(args.includes("--dangerously-skip-permissions"), true);
      }
      assert.equal(command.args.includes("--effort"), false);
      const settingsIndex = command.args.indexOf("--settings");
      assert.ok(settingsIndex >= 0);
      const settings = JSON.parse(fs.readFileSync(command.args[settingsIndex + 1]!, "utf8")) as {
        effortLevel?: string;
      };
      assert.equal(settings.effortLevel, "max");
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
    } finally {
      await command.cleanup?.();
    }
  }
);

bunAdapterTest(
  "generated DeepSeek adapter cleans an upstream command when environment policy rejects it",
  { timeout: 30_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { DeepSeekClaudeCodeAgent } = await loadGeneratedDeepSeekAgent(project);
    type ParentBuildCommand = (params: unknown) => Promise<{
      command: string;
      args: string[];
      cleanup?: () => void | Promise<void>;
    }>;
    const parentPrototype = Object.getPrototypeOf(DeepSeekClaudeCodeAgent.prototype) as {
      buildCommand: ParentBuildCommand;
    };
    const originalParentBuildCommand = parentPrototype.buildCommand;
    const previousAllowlist = process.env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST;
    let cleanupCalls = 0;
    try {
      parentPrototype.buildCommand = async () => ({
        command: "claude",
        args: [],
        cleanup: () => {
          cleanupCalls += 1;
        }
      });
      process.env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST = "invalid-name!";
      const agent = new DeepSeekClaudeCodeAgent({
        effort: "max",
        permissionMode: "bypassPermissions",
        ultrafuzzApiKey: "deepseek-test-key",
        configDir: path.join(project, ".ultrafuzz", "deepseek-claude")
      });
      await assert.rejects(
        agent.buildCommand({ prompt: "Contract only", cwd: project, options: {} }),
        /controller agent environment allowlist is invalid/u
      );
      assert.equal(cleanupCalls, 1);
    } finally {
      parentPrototype.buildCommand = originalParentBuildCommand;
      if (previousAllowlist === undefined) delete process.env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST;
      else process.env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST = previousAllowlist;
    }
  }
);

bunAdapterTest(
  "generated DeepSeek adapter corrects Smithers result and failed-attempt telemetry",
  { timeout: 30_000 },
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

bunAdapterTest(
  "generated DeepSeek adapter rejects ambiguous or noncanonical result telemetry",
  { timeout: 30_000 },
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

bunAdapterTest(
  "generated Pi adapter binds OpenRouter through env and keeps the credential out of argv",
  { timeout: 30_000 },
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
        path.join(configDir, "sessions")
      ]);
      assert.equal(command.stdin, "find a bug");

      // The acceptance criterion: no credential value anywhere in argv, and no
      // `--api-key` flag, because the adapter never sets Smithers' `apiKey`.
      assert.equal(command.args.includes("--api-key"), false);
      assert.equal(
        command.args.some((argument) => argument.includes(credential)),
        false
      );
      assert.equal(command.stdin?.includes(credential), false);
      assert.equal((agent.opts as { apiKey?: string }).apiKey, undefined);

      // Structured-output repair includes the malformed response in the next
      // prompt. Keep a response larger than Linux's common 128 KiB per-argument
      // ceiling entirely out of argv while preserving the ordinary flag list.
      const sensitivePromptMarker = "synthetic-sensitive-prompt-marker";
      const oversizedCorrectionPrompt = [
        "The prior response did not match the required schema. Correct it:\n",
        sensitivePromptMarker,
        "\n",
        "malformed-output-".repeat(9_000)
      ].join("");
      assert.ok(Buffer.byteLength(oversizedCorrectionPrompt, "utf8") > 128 * 1024);
      const oversizedCommand = await agent.buildCommand({
        prompt: oversizedCorrectionPrompt,
        cwd: project,
        options: {}
      });
      assert.deepEqual(oversizedCommand.args, command.args);
      assert.equal(oversizedCommand.stdin, oversizedCorrectionPrompt);
      assert.equal(oversizedCommand.args.includes(oversizedCorrectionPrompt), false);
      assert.equal(
        oversizedCommand.args.some((argument) => argument.includes(sensitivePromptMarker)),
        false
      );
      assert.equal(
        oversizedCommand.args.some((argument) => argument.includes(credential)),
        false
      );
      assert.equal(oversizedCommand.stdin.includes(credential), false);
      assert.deepEqual(oversizedCommand.env, command.env);

      // The credential reaches the child only through the environment, and that
      // environment went through workflowControlChildEnvironment: every
      // controller-only variable is blanked in both layers Smithers composes.
      const childEnv = { ...process.env, ...agent.opts.env, ...command.env };
      assert.equal(childEnv.OPENROUTER_API_KEY, credential);
      assert.equal(agent.opts.env.ULTRAFUZZ_CONFIG_PATH, "");
      assert.equal(command.env?.ULTRAFUZZ_CONFIG_PATH, "");
      assert.equal(childEnv.ULTRAFUZZ_CONFIG_PATH, "");

      // Pi names its NDJSON CLI mode `json`, but Smithers must treat that
      // transcript as `stream-json` so the interpreter's terminal answer wins
      // over earlier JSON-shaped tool results.
      const jsonCommand = await agent.buildCommand({
        prompt: "find a bug",
        cwd: project,
        options: { onEvent: () => undefined }
      });
      assert.deepEqual(jsonCommand.args.slice(0, 3), ["--print", "--mode", "json"]);
      assert.equal(jsonCommand.outputFormat, "stream-json");

      // Isolation: pi's config directory and session storage stay off the
      // operator's real home (~/.pi/agent), and install telemetry is off.
      assert.equal(agent.opts.env.PI_CODING_AGENT_DIR, configDir);
      assert.equal(agent.opts.sessionDir, path.join(configDir, "sessions"));
      assert.equal(agent.opts.env.PI_TELEMETRY, "0");
      assert.equal(agent.opts.env.PI_CODING_AGENT_SESSION_DIR, undefined);

      // A text-free successful terminal assistant message is authoritative.
      // It suppresses stale progress and lower-level whole-transcript fallback
      // without fabricating a model-authored task result.
      const textFreeInterpreter = agent.createOutputInterpreter();
      textFreeInterpreter.onStdoutLine?.(
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "intermediate progress" }
        })
      );
      textFreeInterpreter.onStdoutLine?.(
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "read", arguments: { path: "example" } }]
          }
        })
      );
      const textFreeCompletion = textFreeInterpreter.onStdoutLine?.(
        JSON.stringify({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", name: "read", arguments: { path: "example" } }]
            }
          ]
        })
      );
      const textFreeCompleted = Array.isArray(textFreeCompletion)
        ? textFreeCompletion.find((event) => event.type === "completed")
        : textFreeCompletion;
      assert.equal(textFreeCompleted?.type, "completed");
      assert.equal(textFreeCompleted?.answer, undefined);

      // A later terminal assistant message with text still replaces any
      // earlier progress and is returned unchanged.
      const textInterpreter = agent.createOutputInterpreter();
      textInterpreter.onStdoutLine?.(
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "intermediate progress" }
        })
      );
      const textCompletion = textInterpreter.onStdoutLine?.(
        JSON.stringify({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "final answer" }] }]
        })
      );
      const textCompleted = Array.isArray(textCompletion)
        ? textCompletion.find((event) => event.type === "completed")
        : textCompletion;
      assert.equal(textCompleted?.answer, "final answer");

      // Profile reasoning maps onto pi's existing --thinking level.
      const thinkingAgent = createPiAgent({ model: "openai/gpt-mini-latest", reasoningEffort: "high" });
      const thinkingCommand = await thinkingAgent.buildCommand({ prompt: "x", cwd: project, options: {} });
      const thinkingIndex = thinkingCommand.args.indexOf("--thinking");
      assert.notEqual(thinkingIndex, -1);
      assert.equal(thinkingCommand.args[thinkingIndex + 1], "high");
      const maxThinkingAgent = createPiAgent({ model: "openai/gpt-mini-latest", reasoningEffort: "max" });
      const maxThinkingCommand = await maxThinkingAgent.buildCommand({ prompt: "x", cwd: project, options: {} });
      const maxThinkingIndex = maxThinkingCommand.args.indexOf("--thinking");
      assert.notEqual(maxThinkingIndex, -1);
      assert.equal(maxThinkingCommand.args[maxThinkingIndex + 1], "max");
      // The throw must name the file and the key, not just the range: this is the
      // error an operator hits when selecting a value outside pi's command surface.
      assert.throws(
        () => createPiAgent({ reasoningEffort: "ludicrous" }),
        /models\.<profile>\.reasoning in .*ultrafuzz\.toml is ludicrous, which PiAgent does not support; use one of off, minimal, low, medium, high, xhigh, max/u
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

bunAdapterTest(
  "generated OpenCode adapter preserves its isolated environment and keeps credentials out of argv",
  { timeout: 30_000 },
  async () => {
    const project = tempProject();
    const init = initProject({ projectRoot: project, force: true });
    assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
    const { createOpenCodeAgent } = await loadGeneratedOpenCodeAgent(project);
    const credential = "sk-or-v1-not-a-real-opencode-credential";
    const artifactDir = path.join(project, ".ultrafuzz", "runs", "opencode-contract", "artifacts", "attempt");
    const previous = {
      config: process.env.ULTRAFUZZ_CONFIG_PATH,
      openRouter: process.env.OPENROUTER_API_KEY
    };
    process.env.ULTRAFUZZ_CONFIG_PATH = path.join(project, "ultrafuzz.toml");
    process.env.OPENROUTER_API_KEY = credential;
    try {
      const agent = createOpenCodeAgent({
        model: "openrouter/test-model",
        reasoningEffort: "high",
        addDir: [artifactDir]
      });
      const command = await agent.buildCommand({ prompt: "inspect", cwd: project, options: {} });
      const childEnv = { ...process.env, ...agent.opts.env, ...command.env };
      assert.equal(childEnv.OPENROUTER_API_KEY, credential);
      assert.equal(command.args.includes("--pure"), true);
      assert.equal(command.args.includes("--api-key"), false);
      assert.equal(
        command.args.some((argument) => argument.includes(credential)),
        false
      );
      assert.equal(childEnv.OPENCODE_DISABLE_AUTOUPDATE, "1");
      assert.equal(childEnv.OPENCODE_DISABLE_SHARE, "1");
      assert.equal(childEnv.OPENCODE_PERMISSION, JSON.stringify({ "*": "allow" }));
      assert.equal(childEnv.ULTRAFUZZ_CONFIG_PATH, "");
      assert.equal(childEnv.XDG_CONFIG_HOME?.startsWith(path.join(project, ".ultrafuzz", "runs")), true);
    } finally {
      if (previous.config === undefined) delete process.env.ULTRAFUZZ_CONFIG_PATH;
      else process.env.ULTRAFUZZ_CONFIG_PATH = previous.config;
      if (previous.openRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous.openRouter;
    }
  }
);

bunAdapterTest(
  "generated Kimi adapter narrows the pinned Smithers command to Kimi Code 0.29.1",
  { timeout: 30_000 },
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

    const apiKeyGovernance = path.join(project, "kimi-api-governance.json");
    const apiKeyDestination = modelDestination(
      "KimiAgent",
      { agents: { KimiAgent: { auth: "api-key" } } } as never,
      process.env
    );
    fs.writeFileSync(apiKeyGovernance, JSON.stringify({ required_source_destinations: [apiKeyDestination] }) + "\n");
    const previousGovernancePath = process.env.ULTRAFUZZ_DATA_GOVERNANCE_PATH;
    process.env.ULTRAFUZZ_DATA_GOVERNANCE_PATH = apiKeyGovernance;
    const apiKeyAgent = new KimiCode029Agent({
      model: "kimi-k3",
      configDir: sourceConfig,
      ultrafuzzAuthMode: "api-key",
      ultrafuzzReasoningEffort: "low",
      apiKey: "test-key"
    });
    let apiKeyCommand: Awaited<ReturnType<InstanceType<typeof KimiCode029Agent>["buildCommand"]>> | undefined;
    try {
      apiKeyCommand = await apiKeyAgent.buildCommand({
        prompt: "API key smoke",
        cwd: "/workspace/target",
        options: {}
      });
    } finally {
      if (previousGovernancePath === undefined) delete process.env.ULTRAFUZZ_DATA_GOVERNANCE_PATH;
      else process.env.ULTRAFUZZ_DATA_GOVERNANCE_PATH = previousGovernancePath;
    }
    assert.ok(apiKeyCommand);
    const apiKeyConfigDir = apiKeyCommand.env?.KIMI_SHARE_DIR;
    assert.ok(apiKeyConfigDir);
    assert.equal(apiKeyCommand.env?.KIMI_CODE_HOME, apiKeyConfigDir);
    assert.equal(apiKeyCommand.env?.KIMI_API_KEY, "test-key");
    const apiKeyConfig = fs.readFileSync(path.join(apiKeyConfigDir, "config.toml"), "utf8");
    assert.match(apiKeyConfig, /default_model = "kimi-k3"/);
    assert.match(apiKeyConfig, /\[providers\."ultrafuzz-kimi-api"\]\ntype = "kimi"/);
    assert.doesNotMatch(apiKeyConfig, /api_key|test-key/u);
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
const realKimiAdapterTest = prefixTestNames(
  testWhen(runningUnderBun && fs.existsSync(localKimiCode), { timeout: 60_000 }),
  BUN_ADAPTER_TEST_PREFIX
);

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

realKimiAdapterTest("generated Kimi API config and argv match the real Kimi Code 0.29.1 surface", async () => {
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
  assert.equal(command.env?.KIMI_API_KEY, "contract-test-key");
  const configPath = path.join(command.env.KIMI_CODE_HOME, "config.toml");
  assert.doesNotMatch(fs.readFileSync(configPath, "utf8"), /api_key|contract-test-key/u);
  execFileSync(localKimiCode, ["doctor", "config", path.join(command.env.KIMI_CODE_HOME, "config.toml")], {
    encoding: "utf8",
    env: { ...process.env, ...command.env }
  });
  const parserArgs = [...command.args];
  const modelIndex = parserArgs.indexOf("--model");
  assert.notEqual(modelIndex, -1);
  parserArgs[modelIndex + 1] = "missing-model-for-contract";
  const parsed = spawnKimiSurfaceProbe(localKimiCode, parserArgs, {
    cwd: project,
    env: {
      ...process.env,
      ...command.env,
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
  const runtimeHome = command.env.KIMI_CODE_HOME;
  await command.cleanup?.();
  assert.equal(fs.existsSync(runtimeHome), false);
});

realKimiAdapterTest(
  "generated Kimi subscription config infers managed K3 reasoning efforts",
  { timeout: 15_000 },
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

realKimiAdapterTest(
  "generated Kimi subscription path reflects real Kimi Code 0.29.1 rejecting near-refresh access-only credentials",
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

bunAdapterTest(
  "generated Kimi adapter strictly parses credentials and resume hints without normalization",
  { timeout: 30_000 },
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

bunAdapterTest(
  "generated Kimi adapter strictly parses session indexes and state snapshots",
  { timeout: 30_000 },
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

bunAdapterTest(
  "generated Kimi adapter reports one invocation's wire usage across every agent wire",
  { timeout: 30_000 },
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

bunAdapterTest(
  "generated Kimi adapter reports only the resumed invocation's own tokens",
  { timeout: 30_000 },
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

bunAdapterTest(
  "generated Kimi adapter reports failed-attempt usage and excludes it from a resumed retry",
  { timeout: 30_000 },
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

bunAdapterTest(
  "generated Kimi adapter rejects malformed wire records instead of fabricating tokens",
  { timeout: 30_000 },
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

bunAdapterTest(
  "generated Kimi adapter rejects ambiguous, invalidly encoded, oversized, or deep wire JSON",
  { timeout: 30_000 },
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

bunAdapterTest(
  "generated Kimi adapter reads wire usage only from inside the isolated runtime home",
  { timeout: 30_000 },
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

bunAdapterTest(
  "generated Kimi adapter fails telemetry closed on unsafe wire bounds and replacement",
  { timeout: 30_000 },
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

bunAdapterTest(
  "generated Kimi completed-event usage is what pinned Smithers 0.34.0 consumes",
  { timeout: 30_000 },
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
  assert.ok(validate.diagnostics.some((diagnostic) => diagnostic.code === "CONFIG_MODEL_AGENT_INVALID"));

  const run = await startRun({
    projectRoot: project,
    runId: "unknown-agent",
    agent: "MissingAgent",
    env: fakeSmithersEnv(project)
  });
  assert.equal(run.ok, false);
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "CONFIG_MODEL_AGENT_INVALID"));
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
  assert.match(unknownAgents.join("\n"), /PiAgent/u);
  assert.doesNotMatch(unknownAgents.join("\n"), /OpenRouterAgent/u);

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

test("legacy projects do not require newly added opt-in agent factories", async () => {
  const project = tempProject();
  const initialized = initProject({ projectRoot: project, force: true });
  assert.equal(initialized.ok, true, JSON.stringify(initialized.diagnostics));
  writeSmallTopology(project);

  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace(/\n\[agents\.OpenRouterAgent\][\s\S]*?(?=\n\[(?:agents\.|permissions\]))/u, ""),
    "utf8"
  );
  const registryPath = path.join(project, ".smithers", "agents", "index.ts");
  const legacyRegistry = fs
    .readFileSync(registryPath, "utf8")
    .replace('import { createOpenRouterAgent } from "./openrouter";\n', "")
    .replace('export { createOpenRouterAgent } from "./openrouter";\n', "")
    .replace("  OpenRouterAgent: createOpenRouterAgent,\n", "");
  assert.doesNotMatch(legacyRegistry, /OpenRouterAgent/u);
  fs.writeFileSync(registryPath, legacyRegistry, "utf8");
  fs.unlinkSync(path.join(project, ".smithers", "agents", "openrouter.ts"));

  const preserved = initProject({ projectRoot: project });
  const validate = await validateProject({ projectRoot: project, env: {} });

  assert.equal(preserved.ok, true, JSON.stringify(preserved.diagnostics));
  assert.equal(fs.readFileSync(registryPath, "utf8"), legacyRegistry);
  assert.equal(validate.ok, true, JSON.stringify(validate.diagnostics));
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
      "  OpenCodeAgent: createAgent,\n" +
      "  OpenRouterAgent: createAgent,\n" +
      "  PiAgent: createAgent\n" +
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
  addOpenRouterProfile(project);
  writeSmallTopology(project);
  const registryPath = path.join(project, ".smithers/agents/index.ts");
  const factories =
    "const factory = () => ({ id: 'agent' });\n" +
    "const core = { ClaudeAgent: factory, CodexAgent: factory, DeepSeekAgent: factory, KimiAgent: factory, OpenRouterAgent: factory, PiAgent: factory };\n";

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
    6
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
  addOpenRouterProfile(project);
  writeSmallTopology(project);
  fs.writeFileSync(
    path.join(project, ".smithers/agents/index.ts"),
    'export const decoy = "export const agentFactories = { ClaudeAgent: fake, CodexAgent: fake, DeepSeekAgent: fake, KimiAgent: fake, OpenRouterAgent: fake, PiAgent: fake }";\n' +
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
    ["ClaudeAgent", "CodexAgent", "DeepSeekAgent", "KimiAgent", "OpenRouterAgent", "PiAgent"]
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
    6,
    JSON.stringify(cyclic.diagnostics)
  );

  fs.writeFileSync(
    path.join(project, ".smithers/agents/index.ts"),
    "const registry = { ClaudeAgent: factory, CodexAgent: factory, DeepSeekAgent: factory, KimiAgent: factory, OpenRouterAgent: factory, PiAgent: factory };\n" +
      "export { type registry as agentFactories };\n",
    "utf8"
  );
  const typeSpecifier = await validateProject({ projectRoot: project, env: {} });
  assert.equal(typeSpecifier.ok, false);
  assert.equal(
    typeSpecifier.diagnostics.filter((diagnostic) => diagnostic.code === "AGENT_REFERENCE_UNKNOWN").length,
    6,
    JSON.stringify(typeSpecifier.diagnostics)
  );
});

test("validate accepts quoted factory keys for stock agent IDs", async () => {
  const project = tempProject();
  const init = initProject({ projectRoot: project, force: true });
  assert.equal(init.ok, true, JSON.stringify(init.diagnostics));
  writeSmallTopology(project);
  const registryPath = path.join(project, ".smithers/agents/index.ts");
  fs.writeFileSync(
    registryPath,
    fs
      .readFileSync(registryPath, "utf8")
      .replace("  CodexAgent: createCodexAgent,", '  "CodexAgent": createCodexAgent,'),
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
  assert.deepEqual(renderedValidatorCommandCounts(renderedPrompt), {
    schemaPaths: 1,
    jsonCommands: 1,
    contractCommands: 1
  });
  const expandedOutput = plan
    .value!.expanded_graph.nodes.find((node) => node.id === "project-discovery")
    ?.outputs.find((output) => output.path === "findings.json");
  assert.equal(expandedOutput?.schemaFile, "findings.schema.json");
  assert.equal("schema_file" in (expandedOutput ?? {}), false);
  const schemaPath = path.join(
    plan.value!.layout.workspacesDir,
    "project-discovery",
    ".ultrafuzz",
    "schemas",
    "findings.schema.json"
  );
  const artifactPath = path.join(plan.value!.run_root, "artifacts", "project-discovery", "findings.json");
  assert.ok(
    renderedPrompt.includes(
      `  Validation command: \`ultrafuzz json validate --schema '${schemaPath}' --file '${artifactPath}'\``
    ),
    renderedPrompt
  );
  assert.ok(
    renderedPrompt.includes(
      `  Contract validation command: \`ultrafuzz artifact validate 'ultrafuzz/findings@2' '${artifactPath}'\``
    ),
    renderedPrompt
  );
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

test("producer prompt preflight rejects a missing concrete validator command", () => {
  assert.throws(
    () =>
      assertRenderedPromptValidatorCommands({
        attemptId: "schema-producer",
        outputContractMarkdown:
          "  Validate against: `/trusted/findings.schema.json`\n" +
          "  Contract validation command: `ultrafuzz artifact validate 'ultrafuzz/findings@2' '/artifacts/findings.json'`\n",
        schemaBackedOutputCount: 1
      }),
    /rendered prompt for schema-producer has incomplete producer validator commands: expected 1.+found 1, 0, and 1/u
  );
  assert.doesNotThrow(() =>
    assertRenderedPromptValidatorCommands({
      attemptId: "backtick-path-producer",
      outputContractMarkdown:
        "  Validate against: ``/trusted/with`tick/findings.schema.json``\n" +
        "  Validation command: `` ultrafuzz json validate --schema '/trusted/with`tick/findings.schema.json' --file '/artifacts/findings.json' ``\n" +
        "  Contract validation command: `` ultrafuzz artifact validate 'ultrafuzz/findings@2' '/artifacts/findings.json' ``\n",
      schemaBackedOutputCount: 1
    })
  );
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
  let plan: Awaited<ReturnType<typeof planRun>>;
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

  // Start from the actual camelCase expanded-graph serialization shape that prompt planning consumes.
  // Every materialized default-profile producer prompt must carry exactly one complete command trio
  // for each agent-authored schema-backed output, including loop-expanded nodes.
  let schemaBackedProducerPromptCount = 0;
  let loopedSchemaBackedProducerPromptCount = 0;
  for (const rendered of plan.value!.rendered_prompts) {
    const expandedNode = plan.value!.expanded_graph.nodes.find((node) => node.id === rendered.node_id);
    assert.ok(expandedNode, rendered.node_id);
    const schemaBackedOutputs = expandedNode.outputs.filter(
      (output) =>
        output.schemaFile !== undefined &&
        !["workspace.patch", "workspace-patch.json", "vulnerability-db-manifest.json"].includes(output.path)
    );
    assert.ok(
      expandedNode.outputs.every((output) => !("schema_file" in output)),
      `${expandedNode.id} must retain the canonical expanded-graph schemaFile spelling`
    );
    assert.deepEqual(
      renderedValidatorCommandCounts(fs.readFileSync(rendered.rendered_prompt_path, "utf8")),
      {
        schemaPaths: schemaBackedOutputs.length,
        jsonCommands: schemaBackedOutputs.length,
        contractCommands: schemaBackedOutputs.length
      },
      rendered.attempt_id
    );
    if (schemaBackedOutputs.length > 0) {
      schemaBackedProducerPromptCount += 1;
      if (expandedNode.loop.count > 1) loopedSchemaBackedProducerPromptCount += 1;
    }
  }
  assert.ok(schemaBackedProducerPromptCount > 0);
  assert.ok(loopedSchemaBackedProducerPromptCount > 0);

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
  assert.equal(plan.value!.resolved_config.run.maxParallelAgents, 4);
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

test("compileSmithersWorkflow seals digest-only reference artifact-manifest authorities", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeReferenceTopology(project);
  const xdgCacheHome = path.join(project, "xdg-cache");
  writeReferenceCache(xdgCacheHome);
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = xdgCacheHome;
  try {
    const plan = await planRun({ projectRoot: project, runId: "reference-manifest-authority", env: {} });
    assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
    const referenceArtifactDir = path.join(plan.value!.run_root, "artifacts", "reference-properties-example");
    const outerManifestPath = path.join(referenceArtifactDir, "artifact-manifest.json");
    const originalBytes = fs.readFileSync(outerManifestPath);
    const originalSha256 = crypto.createHash("sha256").update(originalBytes).digest("hex");
    const { compileSmithersWorkflow } = await import("../src/smithers.js");
    const compiled = compileSmithersWorkflow({
      projectRoot: project,
      config: plan.value!.resolved_config,
      graph: plan.value!.expanded_graph,
      runLayout: plan.value!.layout,
      workflowName: "ultrafuzz-reference-manifest-authority",
      renderedPrompts: plan.value!.rendered_prompts
    });
    const sealedDocument = JSON.parse(fs.readFileSync(compiled.tasksPath, "utf8")) as {
      tasks: Array<{
        attemptId: string;
        referenceArtifactManifestAuthorities?: Array<{
          attemptId: string;
          artifactDir: string;
          sizeBytes: number;
          sha256: string;
        }>;
      }>;
    };
    const consumer = sealedDocument.tasks.find((task) => task.attemptId === "project-discovery");
    assert.deepEqual(consumer?.referenceArtifactManifestAuthorities, [
      {
        attemptId: "reference-properties-example",
        artifactDir: referenceArtifactDir,
        sizeBytes: originalBytes.byteLength,
        sha256: originalSha256
      }
    ]);

    fs.writeFileSync(outerManifestPath, '{"rewritten":true}\n', "utf8");
    const sealedAfterRewrite = JSON.parse(fs.readFileSync(compiled.tasksPath, "utf8")) as typeof sealedDocument;
    assert.deepEqual(
      sealedAfterRewrite.tasks.find((task) => task.attemptId === "project-discovery")
        ?.referenceArtifactManifestAuthorities,
      consumer?.referenceArtifactManifestAuthorities
    );
  } finally {
    if (previousXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = previousXdgCacheHome;
    }
  }
});

test("plan rejects compact authority selection of a pinned reference ancestor", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeReferenceTopology(project);
  const promptPath = path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md");
  fs.writeFileSync(
    promptPath,
    fs
      .readFileSync(promptPath, "utf8")
      .replace(
        "{{artifact_handoff:reference-properties-example}}",
        "{{ancestor_contract_artifact_authority:ultrafuzz/reference-manifest@1}}"
      ),
    "utf8"
  );
  const xdgCacheHome = path.join(project, "xdg-cache");
  writeReferenceCache(xdgCacheHome);
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = xdgCacheHome;
  try {
    const plan = await planRun({ projectRoot: project, runId: "reference-compact-authority", env: {} });

    assert.equal(plan.ok, false);
    assert.match(
      JSON.stringify(plan.diagnostics),
      /compact authority selector `ancestor_contract_artifact_authority:ultrafuzz\/reference-manifest@1` cannot select reference ancestor `reference-properties-example`; fixed reference consumers must use `artifact_path:reference-properties-example` or `artifact_handoff:reference-properties-example`/u
    );
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
  for (const rendered of plan.value!.rendered_prompts) {
    assert.deepEqual(renderedValidatorCommandCounts(fs.readFileSync(rendered.rendered_prompt_path, "utf8")), {
      schemaPaths: 1,
      jsonCommands: 1,
      contractCommands: 1
    });
  }
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
  assert.match(workflowSource, /const agentProcessOutput = z\.strictObject\(\{/);
  assert.match(workflowSource, /completed: z\.literal\(true\)/);
  assert.doesNotMatch(workflowSource, /summary: z\.string\(\)\.min\(1\)/);
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
    tasks: Array<{
      attemptId: string;
      dependencySmithersNodeIds: string[];
      referenceArtifactManifestAuthorities?: unknown;
    }>;
  };
  assert.equal(smithersTasks.pinned_submodules, null);
  assert.equal("layers" in smithersTasks, false);
  assert.ok(smithersTasks.tasks.every((task) => task.referenceArtifactManifestAuthorities === undefined));
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

test("compileSmithersWorkflow marks specialist attempts and their artifact handoffs nonblocking", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOptionalSpecialistTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "compiled-optional-specialist", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-compiled-optional-specialist",
    renderedPrompts: plan.value!.rendered_prompts
  });

  assert.deepEqual(compiled.nonBlockingAttemptIds, ["optional-specialist"]);
  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  const specsPrefix = "const serializedTaskSpecs = ";
  const specsStart = workflowSource.indexOf(specsPrefix);
  const specsEnd = workflowSource.indexOf(" as const;", specsStart);
  assert.ok(specsStart >= 0 && specsEnd > specsStart, workflowSource);
  const specs = JSON.parse(workflowSource.slice(specsStart + specsPrefix.length, specsEnd)) as Array<{
    attemptId: string;
    continueOnFail: boolean;
    dependencyArtifactDirs: string[];
    optionalDependencyArtifactDirs: string[];
    dependencyVerificationProducers: Array<{ attemptId: string; verifierId: string; optional: boolean }>;
  }>;
  const direct = specs.find((task) => task.attemptId === "direct-strategy");
  const specialist = specs.find((task) => task.attemptId === "optional-specialist");
  const report = specs.find((task) => task.attemptId === "final-report");
  assert.equal(direct?.continueOnFail, false);
  assert.equal(specialist?.continueOnFail, true);
  assert.equal(report?.continueOnFail, false);
  assert.deepEqual(specialist?.optionalDependencyArtifactDirs, []);
  assert.deepEqual(report?.dependencyArtifactDirs.map((directory) => path.basename(directory)).sort(), [
    "direct-strategy",
    "optional-specialist"
  ]);
  assert.deepEqual(
    report?.optionalDependencyArtifactDirs.map((directory) => path.basename(directory)),
    ["optional-specialist"]
  );
  assert.deepEqual(report?.dependencyVerificationProducers, [
    { attemptId: "direct-strategy", verifierId: "verify:direct-strategy", optional: false },
    { attemptId: "optional-specialist", verifierId: "verify:optional-specialist", optional: true }
  ]);
  assert.equal(workflowSource.match(/continueOnFail=\{task\.continueOnFail\}/gu)?.length, 5);
});

test("current-controller rendering preserves prompts idempotently and continue policy for a leaf task", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOptionalSpecialistTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "refresh-leaf-continue", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow, renderCurrentSmithersController } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-refresh-leaf-continue",
    renderedPrompts: plan.value!.rendered_prompts
  });
  const tasks = JSON.parse(fs.readFileSync(compiled.tasksPath, "utf8")) as SmithersTaskManifestDocument;
  const persistedPlan = JSON.parse(fs.readFileSync(path.join(plan.value!.layout.root, "plan.json"), "utf8")) as {
    rendered_prompts: Array<{
      attempt_id: string;
      rendered_prompt_snapshot_path: string;
    }>;
  };
  const leaf = tasks.tasks.find((task) => task.attemptId === "final-report");
  assert.ok(leaf);
  leaf.metadata.node.group = "leaf-continue";
  const historicalOutput = tasks.tasks
    .flatMap((task) => task.metadata.artifacts.outputs)
    .find((output) => output.primary === true);
  assert.ok(historicalOutput);
  historicalOutput.contract = "ultrafuzz/findings@2";
  historicalOutput.contractDigest = "0".repeat(64);
  historicalOutput.schemaFile = "findings.schema.json";
  historicalOutput.schemaId = "urn:ultrafuzz:schema:artifacts:findings:2";
  historicalOutput.schemaSha256 = "0".repeat(64);
  historicalOutput.schemaBundleSha256 = "0".repeat(64);
  historicalOutput.validatorBuild = `ultrafuzz-json-validator.v1:${"0".repeat(64)}`;
  const promptedTask = tasks.tasks.find((task) => task.renderedPromptPath !== undefined);
  assert.ok(promptedTask?.renderedPromptPath);
  fs.rmSync(promptedTask.renderedPromptPath);

  const workflowPath = renderCurrentSmithersController({
    projectRoot: project,
    layout: plan.value!.layout,
    smithersRunId: compiled.smithersRunId,
    tasks,
    config: plan.value!.resolved_config,
    expandedGraph: { groups: { "leaf-continue": { defaults: { failure_policy: "continue" } } } }
  });
  const workflowSource = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflowSource, /const replacePromptSchemas = true;/u);
  const specsPrefix = "const serializedTaskSpecs = ";
  const specsStart = workflowSource.indexOf(specsPrefix);
  const specsEnd = workflowSource.indexOf(" as const;", specsStart);
  assert.ok(specsStart >= 0 && specsEnd > specsStart, workflowSource);
  const specs = JSON.parse(workflowSource.slice(specsStart + specsPrefix.length, specsEnd)) as Array<{
    attemptId: string;
    continueOnFail: boolean;
    outputs: Array<{ contract: string; contractDigest: string; schemaBundleSha256?: string }>;
    promptPath?: string;
  }>;
  assert.equal(specs.find((task) => task.attemptId === "final-report")?.continueOnFail, true);
  const reboundOutput = specs
    .flatMap((task) => task.outputs)
    .find((output) => output.contract === historicalOutput.contract);
  assert.equal(reboundOutput?.contractDigest, artifactContractDefinition(historicalOutput.contract).digest);
  assert.equal(
    reboundOutput?.schemaBundleSha256,
    artifactContractSchemaBinding(historicalOutput.contract)?.schema_bundle_sha256
  );
  const plannedPrompt = persistedPlan.rendered_prompts.find((prompt) => prompt.attempt_id === promptedTask.attemptId);
  assert.ok(plannedPrompt);
  const snapshotPath = path.join(plan.value!.layout.root, plannedPrompt.rendered_prompt_snapshot_path);
  assert.equal(specs.find((task) => task.attemptId === promptedTask.attemptId)?.promptPath, snapshotPath);

  // The workflow runtime persists the current task specifications back to tasks.json. A later
  // refresh therefore sees the retained path produced above, not the cleanup-owned launch path.
  // It must accept only that exact authenticated snapshot and produce the same prompt binding.
  promptedTask.renderedPromptPath = snapshotPath;
  const repeatedWorkflowPath = renderCurrentSmithersController({
    projectRoot: project,
    layout: plan.value!.layout,
    smithersRunId: compiled.smithersRunId,
    tasks,
    config: plan.value!.resolved_config,
    expandedGraph: { groups: { "leaf-continue": { defaults: { failure_policy: "continue" } } } }
  });
  const repeatedSource = fs.readFileSync(repeatedWorkflowPath, "utf8");
  const repeatedStart = repeatedSource.indexOf(specsPrefix);
  const repeatedEnd = repeatedSource.indexOf(" as const;", repeatedStart);
  assert.ok(repeatedStart >= 0 && repeatedEnd > repeatedStart, repeatedSource);
  const repeatedSpecs = JSON.parse(
    repeatedSource.slice(repeatedStart + specsPrefix.length, repeatedEnd)
  ) as typeof specs;
  assert.equal(repeatedSpecs.find((task) => task.attemptId === promptedTask.attemptId)?.promptPath, snapshotPath);
  assert.equal(repeatedSpecs.find((task) => task.attemptId === "final-report")?.continueOnFail, true);

  promptedTask.renderedPromptPath = path.join(plan.value!.layout.root, "prompt-snapshots", `${"0".repeat(64)}.md`);
  assert.throws(
    () =>
      renderCurrentSmithersController({
        projectRoot: project,
        layout: plan.value!.layout,
        smithersRunId: compiled.smithersRunId,
        tasks,
        config: plan.value!.resolved_config
      }),
    /persisted prompt plan does not match continuation task/u
  );
});

test("current-controller rendering fails closed on retained prompt snapshot drift", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOptionalSpecialistTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "refresh-prompt-drift", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow, renderCurrentSmithersController } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-refresh-prompt-drift",
    renderedPrompts: plan.value!.rendered_prompts
  });
  const tasks = JSON.parse(fs.readFileSync(compiled.tasksPath, "utf8")) as SmithersTaskManifestDocument;
  const persistedPlan = JSON.parse(fs.readFileSync(path.join(plan.value!.layout.root, "plan.json"), "utf8")) as {
    rendered_prompts: Array<{ attempt_id: string; rendered_prompt_snapshot_path: string }>;
  };
  const promptedTask = tasks.tasks.find((task) => task.renderedPromptPath !== undefined);
  assert.ok(promptedTask);
  const plannedPrompt = persistedPlan.rendered_prompts.find((prompt) => prompt.attempt_id === promptedTask.attemptId);
  assert.ok(plannedPrompt);
  fs.appendFileSync(path.join(plan.value!.layout.root, plannedPrompt.rendered_prompt_snapshot_path), "drift\n");

  assert.throws(
    () =>
      renderCurrentSmithersController({
        projectRoot: project,
        layout: plan.value!.layout,
        smithersRunId: compiled.smithersRunId,
        tasks,
        config: plan.value!.resolved_config
      }),
    /retained rendered prompt snapshot digest does not match task/u
  );
});

test("compileSmithersWorkflow seals the canonical selector union from rendered prompt provenance", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOptionalSpecialistTopology(project);
  const plan = await planRun({ projectRoot: project, runId: "compiled-prompt-authority-selectors", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const reportPrompt = plan.value!.rendered_prompts.find((prompt) => prompt.attempt_id === "final-report");
  assert.ok(reportPrompt);
  const firstPaths = ["reports/alpha.json", "reports/zeta.json"];
  const secondPaths = ["reports/alpha.json", "reports/beta.json"];
  const firstPathSelector = {
    kind: "path" as const,
    id: promptArtifactAuthorityPathSelectorId(firstPaths),
    paths: firstPaths
  };
  const secondPathSelector = {
    kind: "path" as const,
    id: promptArtifactAuthorityPathSelectorId(secondPaths),
    paths: secondPaths
  };
  reportPrompt.artifact_references = [
    { kind: "artifact_path" },
    {
      kind: "ancestor_contract_artifact_authority",
      logicalIds: [],
      contract: "ultrafuzz/generated-tests@3"
    },
    {
      kind: "ancestor_artifact_path_authority",
      logicalIds: [],
      selectorId: firstPathSelector.id,
      relativePaths: firstPaths
    },
    { kind: "ancestor_contract_artifact_authority", logicalIds: [], contract: "ultrafuzz/findings@2" },
    {
      kind: "ancestor_artifact_path_authority",
      logicalIds: [],
      selectorId: secondPathSelector.id,
      relativePaths: secondPaths
    },
    {
      kind: "ancestor_contract_artifact_authority",
      logicalIds: [],
      contract: "ultrafuzz/generated-tests@3"
    }
  ];
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compileInput = {
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-compiled-prompt-authority-selectors",
    renderedPrompts: plan.value!.rendered_prompts
  };
  const compiled = compileSmithersWorkflow(compileInput);
  const expectedSelectors = [
    { kind: "contract", contract: "ultrafuzz/findings@2" },
    { kind: "contract", contract: "ultrafuzz/generated-tests@3" },
    ...[firstPathSelector, secondPathSelector].sort((left, right) => left.id.localeCompare(right.id))
  ];

  const taskManifest = JSON.parse(fs.readFileSync(compiled.tasksPath, "utf8")) as {
    tasks: Array<{ attemptId: string; promptArtifactAuthoritySelectors?: unknown[] }>;
  };
  const reportTask = taskManifest.tasks.find((task) => task.attemptId === "final-report");
  const directTask = taskManifest.tasks.find((task) => task.attemptId === "direct-strategy");
  assert.deepEqual(reportTask?.promptArtifactAuthoritySelectors, expectedSelectors);
  assert.equal("promptArtifactAuthoritySelectors" in directTask!, false);

  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  const specsPrefix = "const serializedTaskSpecs = ";
  const specsStart = workflowSource.indexOf(specsPrefix);
  const specsEnd = workflowSource.indexOf(" as const;", specsStart);
  assert.ok(specsStart >= 0 && specsEnd > specsStart, workflowSource);
  const specs = JSON.parse(workflowSource.slice(specsStart + specsPrefix.length, specsEnd)) as Array<{
    attemptId: string;
    promptArtifactAuthoritySelectors?: unknown[];
  }>;
  assert.deepEqual(
    specs.find((task) => task.attemptId === "final-report")?.promptArtifactAuthoritySelectors,
    expectedSelectors
  );
  assert.equal(
    "promptArtifactAuthoritySelectors" in specs.find((task) => task.attemptId === "direct-strategy")!,
    false
  );

  reportPrompt.artifact_references = [
    {
      kind: "ancestor_contract_artifact_authority",
      logicalIds: [],
      contract: "ultrafuzz/not-a-registered-contract@1"
    }
  ];
  assert.throws(() => compileSmithersWorkflow(compileInput), /unknown prompt artifact authority contract/u);
  reportPrompt.artifact_references = [
    {
      kind: "ancestor_artifact_path_authority",
      logicalIds: [],
      selectorId: firstPathSelector.id,
      relativePaths: ["../controller-secret.json"]
    }
  ];
  assert.throws(() => compileSmithersWorkflow(compileInput), /invalid prompt artifact authority path selector group/u);
});

test("compileSmithersWorkflow maps cloud attempts to portable provider sandboxes", async () => {
  const project = tempProject();
  writeFanoutProject(project);
  fs.appendFileSync(path.join(project, "ultrafuzz.toml"), "\n[retry]\nsame_agent_attempts = 1\n", "utf8");
  const topologyPath = path.join(project, ".ultrafuzz", "topology.yml");
  fs.writeFileSync(
    topologyPath,
    fs.readFileSync(topologyPath, "utf8").replace(
      `  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - signal-analysis
`,
      `  - id: cloud-consumer
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - signal-analysis
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
      - cloud-consumer
`
    ),
    "utf8"
  );
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
        credentialEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
      }
    }
  };
  const { assertCurrentCloudAgentCredentialEnvironment, compileSmithersWorkflow } = await import("../src/smithers.js");
  const cloudEnv = {
    ULTRAFUZZ_AGENT_ENV_ALLOWLIST:
      "claude_code_use_bedrock,AWS_ACCESS_KEY_ID,AWS_REGION,AWS_SESSION_TOKEN,aws_case_token,CUSTOM_SHARED_TOKEN,MAINNET_RPC_URL,PRIVATE_RPC_URL",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_ACCESS_KEY_ID: "AKIA0123456789ABCDEF",
    AWS_REGION: "us-east-1",
    AWS_SESSION_TOKEN: "secret",
    aws_case_token: "case-variant-claude-token",
    CUSTOM_SHARED_TOKEN: "must-not-cross-provider-boundaries",
    MAINNET_RPC_URL: "https://rpc.invalid",
    PRIVATE_RPC_URL: `https://eth-mainnet.g.alchemy.com/v2/${"a".repeat(32)}`
  };
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    env: cloudEnv,
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
  assert.deepEqual(discovery.execution.agentCredentialEnv, [
    "AWS_REGION",
    "CLAUDE_CODE_USE_BEDROCK",
    "MAINNET_RPC_URL",
    "OPENAI_API_KEY",
    "ULTRAFUZZ_AGENT_ENV_ALLOWLIST"
  ]);
  assert.deepEqual(compiled.tasks.find((task) => task.agentRef === "ClaudeAgent")?.execution.agentCredentialEnv, [
    "AWS_ACCESS_KEY_ID",
    "AWS_REGION",
    "AWS_SESSION_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "MAINNET_RPC_URL",
    "ULTRAFUZZ_AGENT_ENV_ALLOWLIST",
    "ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES",
    "aws_case_token"
  ]);
  assert.doesNotThrow(() =>
    assertCurrentCloudAgentCredentialEnvironment(
      plan.value!.resolved_config,
      compiled.tasks,
      Object.fromEntries(Object.entries(cloudEnv).reverse())
    )
  );
  assert.throws(
    () =>
      assertCurrentCloudAgentCredentialEnvironment(plan.value!.resolved_config, compiled.tasks, {
        ...cloudEnv,
        MAINNET_RPC_URL: `https://eth-mainnet.g.alchemy.com/v2/${"b".repeat(32)}`
      }),
    /cloud agent credential classification changed after workflow compilation/u
  );
  const workflowSource = fs.readFileSync(compiled.workflowPath, "utf8");
  assert.match(workflowSource, /<Sandbox/);
  assert.match(workflowSource, /<Sandbox[\s\S]*?retries=\{0\}/u);
  assert.match(
    workflowSource,
    /timeoutMs=\{modalModule\.modalNodeLifecycleTimeoutMs\(task\.execution\.resources\.timeoutSeconds\)\}/u
  );
  assert.match(
    workflowSource,
    /heartbeatTimeoutMs=\{modalModule\.modalNodeLifecycleTimeoutMs\(task\.execution\.resources\.timeoutSeconds\)\}/u
  );
  assert.match(workflowSource, /timeout_seconds: task\.execution\.resources\.timeoutSeconds/u);
  assert.match(workflowSource, /timeoutMs=\{task\.timeoutMs\}/u);
  assert.match(
    workflowSource,
    /<Task[\s\S]*?agent=\{agentForTask\(task, fullTaskPrompt\)\}[\s\S]*?retries=\{task\.retries\}/u
  );
  assert.match(workflowSource, /createModalNodeSandboxProvider/);
  assert.match(workflowSource, /schema_version: "ultrafuzz\.modal\.node\.v2"/);
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
  const specsPrefix = "const serializedTaskSpecs = ";
  const specsStart = workflowSource.indexOf(specsPrefix);
  const specsEnd = workflowSource.indexOf(" as const;", specsStart);
  assert.ok(specsStart >= 0 && specsEnd > specsStart, workflowSource);
  const specs = JSON.parse(workflowSource.slice(specsStart + specsPrefix.length, specsEnd)) as Array<{
    attemptId: string;
    dependencyVerificationProducers: Array<{
      attemptId: string;
      verifierId: string;
      optional: boolean;
    }>;
  }>;
  const consumer = specs.find((task) => task.attemptId === "cloud-consumer");
  assert.deepEqual(consumer?.dependencyVerificationProducers, [
    {
      attemptId: "project-discovery__model_0__attempt_0",
      verifierId: "verify:project-discovery__model_0__attempt_0",
      optional: false
    },
    {
      attemptId: "project-discovery__model_1__attempt_1",
      verifierId: "verify:project-discovery__model_1__attempt_1",
      optional: false
    },
    {
      attemptId: "signal-analysis__model_0__attempt_0",
      verifierId: "verify:signal-analysis__model_0__attempt_0",
      optional: false
    },
    {
      attemptId: "signal-analysis__model_1__attempt_1",
      verifierId: "verify:signal-analysis__model_1__attempt_1",
      optional: false
    }
  ]);
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
      .replace("[agents.CodexAgent]", "[retry]\nsame_agent_attempts = 1\n\n[agents.CodexAgent]")
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
        credentialEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
      }
    }
  };
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    env: { KIMI_BASE_URL: "https://kimi.example.invalid/v1" },
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-cloud-kimi-nodes",
    renderedPrompts: plan.value!.rendered_prompts
  });

  const discovery = compiled.tasks.find((task) => task.metadata.node.logicalNodeId === "project-discovery");
  assert.ok(discovery);
  assert.equal(discovery.agentRef, "KimiAgent");
  assert.deepEqual(discovery.execution.agentCredentialEnv, ["KIMI_API_KEY", "KIMI_BASE_URL", "MOONSHOT_API_KEY"]);
});

test("compileSmithersWorkflow escapes the evidence workflow import", async () => {
  const parent = tempProject();
  const project = path.join(parent, 'checkout"quoted');
  fs.mkdirSync(project);
  writeFanoutProject(project);

  const plan = await planRun({ projectRoot: project, runId: "escaped-import", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const { compileSmithersWorkflow } = await import("../src/smithers.js");
  const quotedProjectRoot = path.join(project, 'checkout"quoted');
  fs.mkdirSync(quotedProjectRoot);
  initProject({ projectRoot: quotedProjectRoot, force: true });
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
  assert.match(workflowSource, /const fullTaskPrompt = renderAgentPrompt/u);
  assert.match(workflowSource, /runtimeContext: task\.runtimeContext/u);
  assert.match(workflowSource, /operatorPrompt,/u);
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
      .replace(
        "[agents.CodexAgent]",
        '[retry]\nsame_agent_attempts = 3\nagents = ["sol-xhigh", "gpt55-xhigh"]\n\n[agents.CodexAgent]'
      )
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
      .replace(
        "[agents.CodexAgent]",
        '[retry]\nsame_agent_attempts = 99\nagents = ["primary", "fallback"]\n\n[agents.CodexAgent]'
      )
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
      .replace(
        "[agents.CodexAgent]",
        '[retry]\nsame_agent_attempts = 1\nagents = ["primary", "fallback"]\n\n[agents.CodexAgent]'
      )
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
    .replace("[agents.CodexAgent]", "[retry]\nsame_agent_attempts = 2\n\n[agents.CodexAgent]");
  fs.writeFileSync(
    configPath,
    `${config}\n[execution.providers.modal]\napp = "ultrafuzz-test"\nimage = "ultrafuzz-test"\ncredential_env = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]\n`,
    "utf8"
  );

  const runId = "cloud-retry-chain-rejected";
  const result = await planRun({
    projectRoot: project,
    runId,
    env: { MODAL_TOKEN_ID: "provider-one", MODAL_TOKEN_SECRET: "provider-two", OPENAI_API_KEY: "agent-key" }
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
      .replace(
        "[agents.CodexAgent]",
        '[retry]\nsame_agent_attempts = 2\nagents = ["sol-xhigh", "gpt55-xhigh"]\n\n[agents.CodexAgent]'
      )
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
  const claudeHome = path.join(project, "claude-home");
  const environmentLog = path.join(project, "claude-environment.log");
  const run = await startRun({
    projectRoot: project,
    runId: "agent-switch",
    agent: "ClaudeAgent",
    env: { ...fakeSmithersEnv(project), CLAUDE_CONFIG_DIR: claudeHome, SMITHERS_FAKE_ENV_LOG: environmentLog }
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(environmentLog, "utf8"), `|||${claudeHome}||\n`);

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
  // OpenCodeAgent, OpenRouterAgent, and PiAgent existed: the registry predates the adapters, and init preserves
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
  assert.equal(stale.length, 6, JSON.stringify(upgraded.diagnostics));
  assert.equal(stale[0]?.severity, "warning");
  assert.match(stale.map((entry) => entry.message).join("\n"), /ClaudeAgent/);
  assert.match(stale.map((entry) => entry.message).join("\n"), /DeepSeekAgent/);
  assert.match(stale.map((entry) => entry.message).join("\n"), /KimiAgent/);
  assert.match(stale.map((entry) => entry.message).join("\n"), /OpenCodeAgent/);
  assert.match(stale.map((entry) => entry.message).join("\n"), /OpenRouterAgent/);
  assert.match(stale.map((entry) => entry.message).join("\n"), /PiAgent/);

  // A registry that names Claude, DeepSeek, Kimi, OpenCode, OpenRouter, and Pi without registering
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
  assert.equal(namedStale.length, 6, JSON.stringify(named.diagnostics));
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /ClaudeAgent/);
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /DeepSeekAgent/);
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /KimiAgent/);
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /OpenCodeAgent/);
  assert.match(namedStale.map((entry) => entry.message).join("\n"), /OpenRouterAgent/);
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

testWhen(process.platform !== "win32")(
  "post-init registry inspection rejects symlinks, FIFOs, and oversized files without reading them",
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

test("startRun persists a bounded eval run id verbatim in the submitted workflow input", async () => {
  // The persisted smithers/input.json bytes are the exact --input the workflow
  // runner byte-validates against the generated workflow's compiled
  // z.literal(run id) at detached-launch preflight. The speculative redaction
  // heuristics flag the eval lane's bounded run ids (ci-<run_id>-…-<hex16>) as
  // secrets; rewriting the id to "<redacted>" failed every eval submission as
  // INVALID_INPUT (#899).
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const boundedEvalRunId = "ci-32878286998-1-smoke-ultrafuzz-benc-346bb576f2a1a2e3";

  const run = await startRun({ projectRoot: project, runId: boundedEvalRunId, env: fakeSmithersEnv(project) });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const persisted = fs.readFileSync(path.join(run.value!.run_root, "smithers", "input.json"), "utf8");
  assert.doesNotMatch(persisted, /<redacted>/u);
  const smithersInput = JSON.parse(persisted) as { ultrafuzz_run_id?: string };
  assert.equal(smithersInput.ultrafuzz_run_id, boundedEvalRunId);
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
  for (const moduleName of ["artifacts", "runtime", "modal"] as const) {
    const sealedRelativeEntry = `../../modules/@ultrafuzz/${moduleName}/dist/index.js`;
    assert.equal(
      workflowSource.includes(`new URL(${JSON.stringify(sealedRelativeEntry)}, import.meta.url).href`),
      true,
      `${moduleName} fallback must resolve from the sealed workflow snapshot`
    );
    assert.equal(
      workflowSource.includes(import.meta.resolve(`@ultrafuzz/${moduleName}`)),
      false,
      `${moduleName} fallback must not capture the operator checkout`
    );
    if (moduleName !== "modal") {
      const sealedWorkflowUrl = pathToFileURL(
        path.join(localExecutionSnapshot, ".smithers", "workflows", "ultrafuzz-smithers-run.tsx")
      );
      assert.equal(
        fs.statSync(fileURLToPath(new URL(sealedRelativeEntry, sealedWorkflowUrl))).isFile(),
        true,
        `${moduleName} fallback must identify a sealed snapshot module`
      );
    }
  }
  assert.match(workflowSource, /const agentProcessOutput = z\.strictObject\(\{[\s\S]*?completed: z\.literal\(true\)/u);
  assert.doesNotMatch(workflowSource, /const taskOutput|summary: z\.string\(\)\.min\(1\)/u);
  assert.match(workflowSource, /const preparationOutput = z\.strictObject\(/u);
  assert.match(workflowSource, /const verificationOutput = z\.strictObject\(/u);
  assert.doesNotMatch(workflowSource, /z\.object\(/u);
  // Explicit index path: a sibling .smithers/agents.ts scaffolded by Smithers
  // would otherwise shadow the .smithers/agents/ directory under bun.
  assert.match(workflowSource, /import \{ agentFactories as projectAgentFactories \} from "\.\.\/agents\/index\.ts";/);
  assert.doesNotMatch(workflowSource, /from "\.\.\/agents";/);
  assert.match(workflowSource, /agent=\{agentForTask\(task, fullTaskPrompt\)\}/);
  assert.match(workflowSource, /addDir:\s*\[task\.artifactDir, \.\.\.dependencyArtifactDirs\]/);
  assert.match(workflowSource, /baseAgentForProfile\(task, profile, admittedDependencyArtifactDirs\(task\)\)/u);
  assert.doesNotMatch(workflowSource, /addDir:\s*\[task\.artifactDir, \.\.\.task\.dependencyArtifactDirs\]/u);
  assert.match(workflowSource, /const schemaDirectory = path\.join\(workspaceRoot, "\.ultrafuzz", "schemas"\)/u);
  assert.match(workflowSource, /const replacePromptSchemas = false;/u);
  assert.match(
    workflowSource,
    /materializePromptSchemas\(schemaDirectory, \{ replaceExisting: replacePromptSchemas \}\)/u
  );
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
  assert.match(
    workflowSource,
    /const result = await executionAgent\.generate\(unstructuredArgs\);[\s\S]*?assertDependencyArtifactAdmissionCurrent\(task\);[\s\S]*?_output: \{ completed: true \}/u
  );
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
  assert.match(workflowSource, /output=\{outputs\.agentProcess\}/);
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
  assert.match(workflowSource, /const baseBranch = worktreeBaseBranch\(task\)/u);
  assert.match(workflowSource, /baseBranch === undefined \? \{\} : \{ baseBranch \}/u);
  assert.match(workflowSource, /function readGovernedSource\(\): \{ commit: string; tree: string \} \| undefined/);
  assert.doesNotMatch(workflowSource, /resolveLocalSourceCommit/u);
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

test("getRunHealth stays readable while execution holds the workflow control lock", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await startRun({ projectRoot: project, runId: "concurrent-health-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root, run.value!.run_id);
  const linkJournalPath = path.join(run.value!.run_root, "smithers", "workflow-run-link-journal.json");
  const linkJournalBefore = fs.readFileSync(linkJournalPath);
  const release = await acquireWorkflowControlLock(layout);
  let timeout: NodeJS.Timeout | undefined;
  const healthPromise = getRunHealth({ projectRoot: project, runId: run.value!.run_id, env });
  try {
    const winner = await Promise.race([
      healthPromise.then(() => "health" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), 10_000);
      })
    ]);
    assert.equal(winner, "health", "status waited on the execution-only workflow control lock");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await release();
  }
  const health = await healthPromise;
  assert.equal(health.ok, true, JSON.stringify(health.diagnostics));
  assert.equal(health.value?.run_id, run.value!.run_id);
  assert.deepEqual(fs.readFileSync(linkJournalPath), linkJournalBefore);

  const snapshotsRoot = path.join(run.value!.run_root, "smithers", "execution-snapshots");
  const parkedSnapshotsRoot = path.join(run.value!.run_root, "smithers", "execution-snapshots.parked");
  fs.renameSync(snapshotsRoot, parkedSnapshotsRoot);
  try {
    const missingPublication = await readLinkedWorkflowEvidence(project, run.value!.run_id, { observeOnly: true });
    assert.equal(missingPublication.ok, false);
    assert.equal(fs.existsSync(snapshotsRoot), false, "observer recreated missing snapshot storage");
  } finally {
    fs.renameSync(parkedSnapshotsRoot, snapshotsRoot);
  }
});

test("getRunHealth reports a terminal product status while workflow health is live", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "lifecycle-status-divergence";
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      error: { message: "launcher exited while workflow work remained active" },
      steps: [{ id: "node:project-discovery", state: "pending", attempt: 0 }]
    }),
    status: currentStatusEnvelope(workflowRunId)
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const health = await getRunHealth({ projectRoot: project, runId, env });

  assert.equal(health.ok, false, JSON.stringify(health.diagnostics));
  assert.equal(health.value?.status, "failed");
  assert.equal(health.value?.workflow_status, "running");
  const divergence = health.diagnostics.filter((diagnostic) => diagnostic.code === "RUN_WORKFLOW_STATUS_DIVERGED");
  assert.equal(divergence.length, 1, JSON.stringify(health.diagnostics));
  assert.equal(divergence[0]?.severity, "warning");
  assert.deepEqual(divergence[0]?.details, {
    run_status: "failed",
    workflow_status: "running"
  });
  assert.match(divergence[0]?.message ?? "", /workflow work may still be active/u);
  const unattributed = health.diagnostics.find(
    (diagnostic) => diagnostic.code === "WORKFLOW_TERMINAL_WITHOUT_FAILED_NODE"
  );
  assert.equal(unattributed?.severity, "error");
});

test("a divergent published control file leaves status readable while native resume delegates", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const runId = "diverged-control-status";
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  // Diverge the PUBLISHED snapshot copy of the generated workflow, which is what the seal check
  // compares once a snapshot exists. The project copy stays byte-identical to the seal, exactly as
  // observed in issue #674.
  const snapshotsRoot = path.join(run.value!.run_root, "smithers", "execution-snapshots");
  const generations = fs.readdirSync(snapshotsRoot);
  assert.equal(generations.length, 1, JSON.stringify(generations));
  const workflowsDir = path.join(snapshotsRoot, generations[0]!, ".smithers", "workflows");
  const workflowFile = fs.readdirSync(workflowsDir).find((entry) => entry.endsWith(".tsx"));
  assert.ok(workflowFile, "published snapshot has no generated workflow");
  const snapshotWorkflowPath = path.join(workflowsDir, workflowFile!);
  const pristine = fs.readFileSync(snapshotWorkflowPath, "utf8");
  // Published snapshots are intentionally read-only, so reaching this state takes a deliberate
  // override — which is exactly what an operator hot-patching a sealed run has to do.
  const publishedMode = fs.statSync(snapshotWorkflowPath).mode;
  fs.chmodSync(snapshotWorkflowPath, 0o644);
  fs.writeFileSync(snapshotWorkflowPath, `${pristine}\n// diverged\n`, "utf8");
  fs.chmodSync(snapshotWorkflowPath, publishedMode);

  // Strict linked-evidence readers still fail closed. Ordinary resume intentionally bypasses these
  // control seals and delegates the persisted workflow and same run ID directly to Smithers.
  const strict = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(strict.ok, false);
  if (!strict.ok) {
    assert.equal(strict.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
    assert.match(strict.diagnostics[0]?.message ?? "", /sealed workflow control file changed: workflow/u);
  }
  const resumed = await resumeRun({ projectRoot: project, runId, env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));

  // An observer reads the same run, and is told exactly what diverged.
  const observed = await readLinkedWorkflowEvidence(project, runId, { tolerateControlDivergence: true });
  assert.equal(observed.ok, true, JSON.stringify(observed.ok ? [] : observed.diagnostics));
  if (observed.ok) {
    assert.equal(observed.verifiedControl.divergences.length, 1);
    assert.match(observed.verifiedControl.divergences[0] ?? "", /sealed workflow control file changed: workflow/u);
    // The message must name which copy was compared and both digests, so the divergence is
    // diagnosable without reproducing the capture by hand.
    assert.match(observed.verifiedControl.divergences[0] ?? "", /published execution snapshot copy/u);
    assert.match(observed.verifiedControl.divergences[0] ?? "", /sealed [0-9a-f]{64} \d+ bytes/u);
    assert.match(observed.verifiedControl.divergences[0] ?? "", /observed [0-9a-f]{64} \d+ bytes/u);
  }

  // status reports the run instead of replacing it with an error, and carries the divergence as a warning.
  const health = await getRunHealth({ projectRoot: project, runId, env });
  assert.equal(health.ok, true, JSON.stringify(health.diagnostics));
  assert.equal(health.value?.run_id, runId);
  assert.equal(health.value?.verdict, "running-healthy");
  const diverged = health.diagnostics.filter((diagnostic) => diagnostic.code === "WORKFLOW_CONTROL_EVIDENCE_DIVERGED");
  assert.equal(diverged.length, 1, JSON.stringify(health.diagnostics));
  assert.equal(diverged[0]?.severity, "warning");
  // The divergence is reported exactly once. Synchronization re-reads the same evidence strictly, so
  // running it here would report the identical mismatch a second time as INVALID and leave a healthy
  // response contradicting itself.
  assert.equal(
    health.diagnostics.filter((diagnostic) => diagnostic.code === "WORKFLOW_CONTROL_EVIDENCE_INVALID").length,
    0,
    JSON.stringify(health.diagnostics)
  );
  const skipped = health.diagnostics.filter((diagnostic) => diagnostic.code === "WORKFLOW_STATE_SYNC_SKIPPED");
  assert.equal(skipped.length, 1, JSON.stringify(health.diagnostics));
  assert.equal(skipped[0]?.severity, "warning");

  // The divergence is never silently repaired.
  assert.equal(fs.readFileSync(snapshotWorkflowPath, "utf8"), `${pristine}\n// diverged\n`);
});

test("an observer still refuses a run whose sealed execution files diverged", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const runId = "diverged-execution-file";
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  // Execution files are what `status` itself runs: the snapshot env binds the runner executable and the
  // sealed module URLs inside the snapshot. Tolerating divergence here would mean executing tampered
  // code to report the tampering, so this must stay fatal even for a read-only caller.
  const seal = JSON.parse(
    fs.readFileSync(path.join(run.value!.run_root, "smithers", "control-integrity.json"), "utf8")
  ) as { execution_files: { snapshot_path: string }[] };
  const generations = fs.readdirSync(path.join(run.value!.run_root, "smithers", "execution-snapshots"));
  const snapshotRoot = path.join(run.value!.run_root, "smithers", "execution-snapshots", generations[0]!);
  const target = path.join(snapshotRoot, ...seal.execution_files[0]!.snapshot_path.split("/"));
  const originalMode = fs.statSync(target).mode;
  fs.chmodSync(target, 0o644);
  fs.appendFileSync(target, "\n// diverged\n", "utf8");
  fs.chmodSync(target, originalMode);

  const observed = await readLinkedWorkflowEvidence(project, runId, { tolerateControlDivergence: true });
  assert.equal(observed.ok, false);
  if (!observed.ok) {
    assert.equal(observed.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
    assert.match(observed.diagnostics[0]?.message ?? "", /sealed workflow execution file changed/u);
  }
  const health = await getRunHealth({ projectRoot: project, runId, env });
  assert.equal(health.ok, false);
  assert.equal(health.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
});

test("a sealed manifest that stops re-deriving leaves status readable while native resume delegates", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  // `final-report` joins both strategy nodes, which is the shape that broke: issue #866 was reported
  // against `dedupe-findings`, the node that joins every finding producer, because a join's dependency
  // set is the part of a plan a divergent expansion disagrees with.
  writeOptionalSpecialistTopology(project);
  const env = fakeSmithersEnv(project);
  const runId = "diverged-manifest-status";
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  // Drop one dependency from the sealed task manifest's own record of what the join depends on. The
  // manifest still satisfies its schema and the planned graph is untouched, so the failure is a
  // disagreement between two control documents rather than a control file that stopped matching its
  // recorded digest — exactly the class that `parseSealedTaskManifest` turns into a hard throw no
  // tolerance flag could reach.
  const tasksPath = path.join(run.value!.run_root, "smithers", "tasks.json");
  const manifest = JSON.parse(fs.readFileSync(tasksPath, "utf8")) as {
    tasks: { attemptId: string; metadata: { dependencies: { concreteNodeIds: string[] } } }[];
  };
  const join = manifest.tasks.find((task) => task.attemptId === "final-report");
  assert.ok(join, "fixture has no join task to diverge");
  assert.ok(join!.metadata.dependencies.concreteNodeIds.includes("optional-specialist"));
  join!.metadata.dependencies.concreteNodeIds = join!.metadata.dependencies.concreteNodeIds.filter(
    (nodeId) => nodeId !== "optional-specialist"
  );
  fs.writeFileSync(tasksPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // Strict linked-evidence callers still refuse the divergent plan. Ordinary resume intentionally
  // leaves plan/control validation to Smithers' changed-workflow continuation boundary.
  const strict = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(strict.ok, false);
  if (!strict.ok) {
    assert.equal(strict.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
  }
  const resumed = await resumeRun({ projectRoot: project, runId, env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  const cancelled = await cancelRun({ projectRoot: project, runId, env });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");

  // An observer reads the same run and is told which document stopped agreeing, naming the task the
  // re-derivation tripped on so the divergence is diagnosable without reproducing it by hand.
  const observed = await readLinkedWorkflowEvidence(project, runId, { tolerateControlDivergence: true });
  assert.equal(observed.ok, true, JSON.stringify(observed.ok ? [] : observed.diagnostics));
  if (observed.ok) {
    const rederivation = observed.verifiedControl.divergences.filter((divergence) =>
      /sealed task manifest no longer re-derives from its planned graph/u.test(divergence)
    );
    assert.equal(rederivation.length, 1, JSON.stringify(observed.verifiedControl.divergences));
    assert.match(rederivation[0] ?? "", /"final-report" planned dependency nodes do not match/u);
  }

  // status reports the run instead of replacing it with an error, and carries the divergence as a
  // warning next to the note that its counts come from the workflow runner.
  const health = await getRunHealth({ projectRoot: project, runId, env });
  assert.equal(health.ok, true, JSON.stringify(health.diagnostics));
  assert.equal(health.value?.run_id, runId);
  const diverged = health.diagnostics.filter((diagnostic) => diagnostic.code === "WORKFLOW_CONTROL_EVIDENCE_DIVERGED");
  assert.ok(
    diverged.some((diagnostic) => /no longer re-derives from its planned graph/u.test(diagnostic.message)),
    JSON.stringify(health.diagnostics)
  );
  assert.ok(diverged.every((diagnostic) => diagnostic.severity === "warning"));
  assert.equal(
    health.diagnostics.filter((diagnostic) => diagnostic.code === "WORKFLOW_CONTROL_EVIDENCE_INVALID").length,
    0,
    JSON.stringify(health.diagnostics)
  );
  const skipped = health.diagnostics.filter((diagnostic) => diagnostic.code === "WORKFLOW_STATE_SYNC_SKIPPED");
  assert.equal(skipped.length, 1, JSON.stringify(health.diagnostics));
  assert.equal(skipped[0]?.severity, "warning");

  // Reporting the divergence must never repair it.
  assert.equal(
    (JSON.parse(fs.readFileSync(tasksPath, "utf8")) as typeof manifest).tasks
      .find((task) => task.attemptId === "final-report")!
      .metadata.dependencies.concreteNodeIds.includes("optional-specialist"),
    false
  );
});

test("a planned graph that stops matching this build's contracts leaves status readable", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const runId = "diverged-contract-binding-status";
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  // `assertSealedPlannedGraph` looks every output contract up in the *running process's* artifact
  // registry and insists the schema identity recorded at compile time still matches. That is a
  // property of the tree doing the observing, not of the run: an operator whose checkout has moved on
  // since the run was submitted loses `status` for a run that is intact and possibly still executing
  // (issue #866). Rewriting the recorded schema digest reproduces exactly that disagreement without
  // needing two builds.
  const graphPath = path.join(run.value!.run_root, "graph.json");
  const graph = JSON.parse(fs.readFileSync(graphPath, "utf8")) as {
    nodes: { outputs: { path: string; schema_sha256?: string }[] }[];
  };
  const output = graph.nodes.flatMap((node) => node.outputs).find((candidate) => candidate.path === "findings.json");
  assert.ok(output, "fixture has no schema-bound output to diverge");
  output!.schema_sha256 = "a".repeat(64);
  fs.writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  // Strict linked-evidence callers keep reporting the schema drift. Ordinary resume intentionally
  // does not use current artifact bindings as authorization for same-ID Smithers continuation.
  const strict = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(strict.ok, false);
  const resumed = await resumeRun({ projectRoot: project, runId, env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  const cancelled = await cancelRun({ projectRoot: project, runId, env });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");

  const observed = await readLinkedWorkflowEvidence(project, runId, { tolerateControlDivergence: true });
  assert.equal(observed.ok, true, JSON.stringify(observed.ok ? [] : observed.diagnostics));
  if (observed.ok) {
    assert.ok(
      observed.verifiedControl.divergences.some((divergence) =>
        /sealed planned graph no longer re-derives against this build's artifact contracts: planned graph output schema binding changed for "findings\.json"/u.test(
          divergence
        )
      ),
      JSON.stringify(observed.verifiedControl.divergences)
    );
  }

  const health = await getRunHealth({ projectRoot: project, runId, env });
  assert.equal(health.ok, true, JSON.stringify(health.diagnostics));
  assert.equal(health.value?.run_id, runId);
  const diverged = health.diagnostics.filter((diagnostic) => diagnostic.code === "WORKFLOW_CONTROL_EVIDENCE_DIVERGED");
  assert.ok(
    diverged.some((diagnostic) => /output schema binding changed/u.test(diagnostic.message)),
    JSON.stringify(health.diagnostics)
  );
  assert.ok(diverged.every((diagnostic) => diagnostic.severity === "warning"));
  assert.equal(
    health.diagnostics.filter((diagnostic) => diagnostic.code === "WORKFLOW_CONTROL_EVIDENCE_INVALID").length,
    0,
    JSON.stringify(health.diagnostics)
  );
  assert.equal(
    health.diagnostics.filter((diagnostic) => diagnostic.code === "WORKFLOW_STATE_SYNC_SKIPPED").length,
    1,
    JSON.stringify(health.diagnostics)
  );
});

test("sealed Bun startup controls from another build are reported, not equated", () => {
  // The equality check in `materializeWorkflowExecutionSnapshot` compares the run's sealed controls
  // against a constant compiled into whichever build is looking. Every digest in the seal can verify
  // while that comparison fails, which is what an operator on a newer checkout hits, so the condition
  // has to be reportable rather than only throwable.
  const current = [
    {
      sourcePath: "/seal/bun-module-confinement.js",
      snapshotPath: "controls/bun-module-confinement.js",
      contents: Buffer.from(BUN_MODULE_CONFINEMENT_SOURCE)
    },
    { sourcePath: "/seal/bun-empty.env", snapshotPath: "controls/bun-empty.env", contents: Buffer.from("\n") },
    { sourcePath: "/seal/bunfig.toml", snapshotPath: "controls/bunfig.toml", contents: Buffer.from("\n") }
  ];
  assert.equal(sealedBunStartupControlDrift(current), undefined);

  const drifted = current.map((file) =>
    file.snapshotPath === "controls/bun-module-confinement.js"
      ? { ...file, contents: Buffer.from(`${BUN_MODULE_CONFINEMENT_SOURCE}\n// an older release\n`) }
      : file
  );
  assert.equal(
    sealedBunStartupControlDrift(drifted),
    "sealed Bun startup controls were produced by a different build than this one: controls/bun-module-confinement.js"
  );
  // A control the seal does not carry at all is drift too, not a silent pass.
  assert.match(
    sealedBunStartupControlDrift(current.filter((file) => file.snapshotPath !== "controls/bunfig.toml")) ?? "",
    /controls\/bunfig\.toml/u
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
  setFakeSmithersStatus(project, {
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

  setFakeSmithersStatus(project, currentStatusEnvelope("ultrafuzz-another-run"));
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
    setFakeSmithersStatus(project, invalid.value);
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
    setFakeSmithersStatus(project, {
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

  setFakeSmithersStatus(project, {
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

  markFakeSmithersAlreadyPaused(project);
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
    SMITHERS_UNDOCUMENTED_SECRET: "must-not-forward",
    FOUNDRY_PROFILE: "ci",
    ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "FOUNDRY_PROFILE"
  };

  const run = await startRun({ projectRoot: project, runId: "filtered-environment", env });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(environmentLog, "utf8"), "configured-agent-key||ci|||OPENAI_API_KEY\n");
  assert.equal(fs.readFileSync(contextLog, "utf8"), "|||||\n");
});

bunAdapterTest(
  "two active API-key providers reach generated children with only their own credential",
  { timeout: 120_000 },
  async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const topologyPath = path.join(project, ".ultrafuzz", "topology.yml");
    fs.writeFileSync(
      topologyPath,
      fs
        .readFileSync(topologyPath, "utf8")
        .replace(
          "    prompt: setup/project-discovery.md\n    depends_on:\n",
          "    prompt: setup/project-discovery.md\n    model_profiles:\n      - default\n    depends_on:\n"
        )
        .replace(
          "  - id: __finish__\n",
          `  - id: deepseek-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    model_profiles:
      - deepseek
    depends_on:
      - __start__
    outputs:
      - path: setup/deepseek-discovery.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
`
        )
        .replace(
          "    depends_on:\n      - project-discovery\n",
          "    depends_on:\n      - project-discovery\n      - deepseek-discovery\n"
        ),
      "utf8"
    );

    const controllerEnvironmentLog = path.join(project, "smithers-multi-provider-environment.log");
    const controllerCredentialLog = path.join(project, "smithers-multi-provider-credentials.log");
    const openAiKey = "active-openai-key";
    const deepSeekKey = "active-deepseek-key";
    const run = await startRun({
      projectRoot: project,
      runId: "multi-provider-credential-isolation",
      env: {
        ...fakeSmithersEnv(project),
        SMITHERS_FAKE_ENV_LOG: controllerEnvironmentLog,
        SMITHERS_FAKE_RETRY_CREDENTIAL_ENV_LOG: controllerCredentialLog,
        OPENAI_API_KEY: openAiKey,
        DEEPSEEK_API_KEY: deepSeekKey
      }
    });

    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    assert.equal(fs.readFileSync(controllerCredentialLog, "utf8"), `${openAiKey}|${deepSeekKey}\n`);
    const controllerEnvironment = fs.readFileSync(controllerEnvironmentLog, "utf8").trimEnd().split("|");
    assert.equal(controllerEnvironment[0], openAiKey);
    const providerCredentialNames = controllerEnvironment.at(-1);
    assert.equal(providerCredentialNames, "DEEPSEEK_API_KEY,OPENAI_API_KEY");

    const saved = Object.fromEntries(
      ["ULTRAFUZZ_CONFIG_PATH", "ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"].map(
        (name) => [name, process.env[name]]
      )
    );
    process.env.ULTRAFUZZ_CONFIG_PATH = path.join(project, "ultrafuzz.toml");
    process.env.ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES = providerCredentialNames!;
    process.env.OPENAI_API_KEY = openAiKey;
    process.env.DEEPSEEK_API_KEY = deepSeekKey;
    try {
      const { createCodexAgent } = await loadGeneratedCodexAgent(project);
      const codexEnvironment = (createCodexAgent() as { opts: { env: Record<string, string> } }).opts.env;
      assert.equal(codexEnvironment.CODEX_API_KEY, openAiKey);
      assert.equal(codexEnvironment.DEEPSEEK_API_KEY, "");

      const { createDeepSeekAgent } = await loadGeneratedDeepSeekAgent(project);
      const deepSeekCommand = await createDeepSeekAgent().buildCommand({
        prompt: "isolate",
        cwd: project,
        options: {}
      });
      assert.equal(deepSeekCommand.env?.ANTHROPIC_AUTH_TOKEN, deepSeekKey);
      assert.equal(deepSeekCommand.env?.OPENAI_API_KEY, "");
      assert.equal(deepSeekCommand.env?.CODEX_API_KEY, "");
      assert.equal(deepSeekCommand.env?.DEEPSEEK_API_KEY, "");
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
);

test("startRun warns for optional specialist commands but still rejects blocking command gaps", async () => {
  const command = "ultrafuzz-specialist-command-that-does-not-exist";
  const optionalProject = tempProject();
  initProject({ projectRoot: optionalProject, force: true });
  writeOptionalSpecialistTopology(optionalProject, { specialistCommand: command });
  const optionalRun = await startRun({
    projectRoot: optionalProject,
    runId: "optional-specialist-command",
    env: fakeSmithersEnv(optionalProject)
  });
  assert.equal(optionalRun.ok, true, JSON.stringify(optionalRun.diagnostics));
  assert.ok(
    optionalRun.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "RUN_OPTIONAL_COMMAND_MISSING" &&
        diagnostic.severity === "warning" &&
        (diagnostic.details?.commands as string[] | undefined)?.includes(command)
    ),
    JSON.stringify(optionalRun.diagnostics)
  );
  const optionalResume = await resumeRun({
    projectRoot: optionalProject,
    runId: "optional-specialist-command",
    force: true,
    env: fakeSmithersEnv(optionalProject)
  });
  assert.equal(optionalResume.ok, true, JSON.stringify(optionalResume.diagnostics));
  assert.equal(
    optionalResume.diagnostics.some((diagnostic) => diagnostic.code === "RUN_OPTIONAL_COMMAND_MISSING"),
    false,
    "native continuation does not re-run Ultrafuzz command preflight"
  );

  const blockingProject = tempProject();
  initProject({ projectRoot: blockingProject, force: true });
  writeOptionalSpecialistTopology(blockingProject, {
    specialistCommand: command,
    blockingCommand: command
  });
  const blockingRun = await startRun({
    projectRoot: blockingProject,
    runId: "blocking-command",
    env: fakeSmithersEnv(blockingProject)
  });
  assert.equal(blockingRun.ok, false);
  assert.equal(blockingRun.diagnostics[0]?.code, "RUN_REQUIRED_COMMAND_MISSING");
});

test("optional command probes fail closed on exceptions and opaque result sets", async () => {
  const command = "ultrafuzz-optional-probe-failure-command";
  const cases = [
    {
      label: "exception",
      probe: async (): Promise<never> => {
        throw new Error("provider probe transport failed");
      }
    },
    {
      label: "omitted-result",
      probe: async () => []
    }
  ] as const;

  for (const probeCase of cases) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeOptionalSpecialistTopology(project, { specialistCommand: command });
    const run = await startRun({
      projectRoot: project,
      runId: `optional-command-probe-${probeCase.label}`,
      env: fakeSmithersEnv(project),
      requiredCommandProbe: probeCase.probe
    });

    assert.equal(run.ok, false, JSON.stringify(run.diagnostics));
    assert.ok(
      run.diagnostics.some(
        (diagnostic) => diagnostic.code === "RUN_REQUIRED_COMMAND_PREFLIGHT_FAILED" && diagnostic.severity === "error"
      ),
      JSON.stringify(run.diagnostics)
    );
    assert.equal(
      run.diagnostics.some((diagnostic) => diagnostic.code === "RUN_OPTIONAL_COMMAND_MISSING"),
      false
    );
  }
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

test("startRun rejects noncanonical built-in credential environment names", async () => {
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
  assert.equal(run.diagnostics[0]?.code, "CONFIG_AGENT_API_KEY_ENV_NONCANONICAL");
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
      .replace('[execution]\nmode = "local"', '[execution]\nmode = "cloud"\nprovider = "modal"')
      .replace("[agents.CodexAgent]", "[retry]\nsame_agent_attempts = 1\n\n[agents.CodexAgent]")}

[execution.providers.modal]
app = "ultrafuzz-test"
image = "ultrafuzz-test"
credential_env = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
`,
    "utf8"
  );
  const cloudEnvironmentLog = path.join(project, "smithers-cloud-environment.log");
  const pinnedRunner = writeFakeInstalledSmithers(project);
  fs.writeFileSync(
    pinnedRunner.target,
    [
      "#!/bin/sh",
      'if [ -n "$SMITHERS_FAKE_CLOUD_ENV_LOG" ]; then printf \'%s|%s\\n\' "$MODAL_TOKEN_ID" "$MODAL_TOKEN_SECRET" > "$SMITHERS_FAKE_CLOUD_ENV_LOG"; fi',
      'printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"',
      "printf '%s\\n' '{\"ok\":true}'",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(pinnedRunner.target, 0o755);
  const controllerEnvironment = fakeSmithersEnv(project);
  const installer = writeFakeNpmInstaller(project);
  const requireFromTest = createRequire(import.meta.url);
  const requireFromSmithers = createRequire(requireFromTest.resolve("smthrs"));
  const realReactRoot = path.dirname(requireFromSmithers.resolve("react"));
  const realZodRoot = path.dirname(path.dirname(requireFromTest.resolve("zod/v4")));
  const npmFixture = path.join(installer.binDir, "npm");
  fs.chmodSync(npmFixture, 0o700);
  fs.appendFileSync(
    npmFixture,
    `
const reactRoot = path.join(prefix, "node_modules", "react");
const zodRoot = path.join(prefix, "node_modules", "zod");
fs.rmSync(reactRoot, { recursive: true, force: true });
fs.rmSync(zodRoot, { recursive: true, force: true });
fs.cpSync(${JSON.stringify(realReactRoot)}, reactRoot, { recursive: true });
fs.cpSync(${JSON.stringify(realZodRoot)}, zodRoot, { recursive: true });
const smthrsRoot = path.join(prefix, "node_modules", "smthrs");
const smthrsManifest = JSON.parse(fs.readFileSync(path.join(smthrsRoot, "package.json"), "utf8"));
smthrsManifest.type = "module";
smthrsManifest.exports = {
  ".": "./index.js",
  "./jsx-runtime": "./jsx-runtime.js",
  "./jsx-dev-runtime": "./jsx-runtime.js"
};
fs.writeFileSync(path.join(smthrsRoot, "package.json"), JSON.stringify(smthrsManifest) + "\\n");
fs.writeFileSync(
  path.join(smthrsRoot, "index.js"),
  ${JSON.stringify(`
class Agent {
  constructor(options = {}) { this.opts = options; }
  async preflight() {}
  async buildCommand() { return { args: [], env: {} }; }
  async generate() { return {}; }
}
export class SmithersErrorInstance extends Error {}
export class ClaudeCodeAgent extends Agent {}
export class CodexAgent extends Agent {}
export class KimiAgent extends Agent {}
export class OpenCodeAgent extends Agent {}
export class PiAgent extends Agent {}
const component = () => null;
export function createSmithers() {
  return {
    Workflow: component,
    Task: component,
    Worktree: component,
    Parallel: component,
    Sandbox: component,
    smithers: (factory) => ({ factory }),
    outputs: { task: {}, preparation: {}, verification: {} }
  };
}
`)}
);
fs.writeFileSync(
  path.join(smthrsRoot, "jsx-runtime.js"),
  ${JSON.stringify(`
export const Fragment = Symbol.for("ultrafuzz.test.fragment");
export const jsx = (type, props, key) => ({ type, props, key });
export const jsxs = jsx;
export const jsxDEV = jsx;
`)}
);
`
  );
  fs.chmodSync(npmFixture, 0o500);
  const env = {
    ...controllerEnvironment,
    SMITHERS_BIN: undefined,
    SMITHERS_FAKE_CLOUD_ENV_LOG: cloudEnvironmentLog,
    OPENAI_API_KEY: "configured-agent-key",
    MODAL_TOKEN_ID: "provider-one",
    MODAL_TOKEN_SECRET: "provider-two"
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

  const outsideModule = path.join(project, "outside-snapshot.mjs");
  fs.writeFileSync(outsideModule, 'export default "outside";\n', "utf8");
  const snapshotDescriptor = fs.openSync(
    executionSnapshot,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
  );
  try {
    const descriptorRoot = "/proc/self/fd/3";
    const workflowPath = path.join(descriptorRoot, ".smithers", "workflows", "ultrafuzz-cloud-environment.tsx");
    const persistedWorkflowPath = path.join(
      executionSnapshot,
      ".smithers",
      "workflows",
      "ultrafuzz-cloud-environment.tsx"
    );
    const descriptorEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      MODAL_TOKEN_ID: "test-token-id",
      MODAL_TOKEN_SECRET: "test-token-secret",
      OPENAI_API_KEY: "configured-agent-key",
      ULTRAFUZZ_CONFIG_PATH: path.join(descriptorRoot, "controls", "ultrafuzz.toml"),
      ULTRAFUZZ_DATA_GOVERNANCE_PATH: path.join(descriptorRoot, "controls", "data-governance.json"),
      ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: persistedWorkflowPath,
      UFZ_DESCRIPTOR_WORKFLOW_MODULE: pathToFileURL(workflowPath).href,
      UFZ_OUTSIDE_WORKFLOW_MODULE: pathToFileURL(outsideModule).href
    };
    for (const name of ["ULTRAFUZZ_ARTIFACTS_MODULE", "ULTRAFUZZ_MODAL_MODULE", "ULTRAFUZZ_RUNTIME_MODULE"]) {
      delete descriptorEnvironment[name];
    }
    const detachedPreflight = spawnSync(
      "bun",
      [
        `--config=${path.join(descriptorRoot, "controls", "bunfig.toml")}`,
        `--env-file=${path.join(descriptorRoot, "controls", "bun-empty.env")}`,
        "--no-env-file",
        "--no-install",
        "--no-addons",
        "--preserve-symlinks-main",
        `--preload=${path.join(descriptorRoot, "controls", "bun-module-confinement.js")}`,
        "--eval",
        `const workflow = await import(process.env.UFZ_DESCRIPTOR_WORKFLOW_MODULE); if (workflow.default === undefined) throw new Error("generated workflow has no default export"); let rejected; try { await import(process.env.UFZ_OUTSIDE_WORKFLOW_MODULE); } catch (error) { rejected = String(error); } if (!rejected?.includes("outside its sealed snapshot")) throw new Error("outside module was not rejected"); process.stdout.write("descriptor-preflight-ok");`
      ],
      {
        cwd: project,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe", snapshotDescriptor],
        env: descriptorEnvironment
      }
    );
    assert.equal(detachedPreflight.status, 0, detachedPreflight.stderr);
    assert.equal(detachedPreflight.stdout, "descriptor-preflight-ok");
  } finally {
    fs.closeSync(snapshotDescriptor);
  }
});

test("startRun forwards Modal credentials and SDK selectors through the workflow environment filter", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    `${fs
      .readFileSync(configPath, "utf8")
      .replace('[execution]\nmode = "local"', '[execution]\nmode = "cloud"\nprovider = "modal"')
      .replace("[agents.CodexAgent]", "[retry]\nsame_agent_attempts = 1\n\n[agents.CodexAgent]")}

[execution.providers.modal]
app = "ultrafuzz-test"
image = "ultrafuzz-test"
credential_env = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
`,
    "utf8"
  );
  const cloudEnvironmentLog = path.join(project, "smithers-cloud-environment.log");
  const cloudSelectorLog = path.join(project, "smithers-cloud-selectors.log");
  const pinnedRunner = writeFakeInstalledSmithers(project);
  const pinnedRunnerSource = [
    "#!/bin/sh",
    'if [ -n "$SMITHERS_FAKE_CLOUD_ENV_LOG" ]; then',
    '  printf \'%s|%s\\n\' "$MODAL_TOKEN_ID" "$MODAL_TOKEN_SECRET" > "$SMITHERS_FAKE_CLOUD_ENV_LOG"',
    "fi",
    'if [ -n "$SMITHERS_FAKE_CLOUD_SELECTOR_LOG" ] && [ "$1" = "up" ]; then',
    '  printf \'%s|%s|%s|%s\\n\' "$UFZ_PROVIDER_ONE" "$UFZ_PROVIDER_TWO" "$MODAL_ENVIRONMENT" "$MODAL_PROFILE" > "$SMITHERS_FAKE_CLOUD_SELECTOR_LOG"',
    "fi",
    "printf '%s\\n' '{\"ok\":true}'",
    ""
  ].join("\n");
  fs.writeFileSync(pinnedRunner.target, pinnedRunnerSource, "utf8");
  fs.chmodSync(pinnedRunner.target, 0o755);
  const controllerEnvironment = fakeSmithersEnv(project);
  writeFakeNpmInstaller(project, { count: 0, stderr: [], runnerSource: pinnedRunnerSource });
  const env = {
    ...controllerEnvironment,
    SMITHERS_BIN: undefined,
    SMITHERS_FAKE_CLOUD_ENV_LOG: cloudEnvironmentLog,
    SMITHERS_FAKE_CLOUD_SELECTOR_LOG: cloudSelectorLog,
    OPENAI_API_KEY: "configured-agent-key",
    ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "UFZ_PROVIDER_ONE,UFZ_PROVIDER_TWO",
    UFZ_PROVIDER_ONE: "provider-one",
    UFZ_PROVIDER_TWO: "provider-two",
    MODAL_ENVIRONMENT: "selected-environment",
    MODAL_PROFILE: "selected-profile",
    MODAL_TOKEN_ID: "test-token-id",
    MODAL_TOKEN_SECRET: "test-token-secret"
  };

  const run = await startRun({ projectRoot: project, runId: "cloud-environment", env });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(cloudEnvironmentLog, "utf8"), "test-token-id|test-token-secret\n");
  assert.equal(
    fs.readFileSync(cloudSelectorLog, "utf8"),
    "provider-one|provider-two|selected-environment|selected-profile\n"
  );
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
    "||https://kimi.example.invalid/v1|||/data/run/kimi-code-auth|/data/run/kimi-code-sessions|/data/run\n"
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
      .replace(
        "[agents.CodexAgent]",
        '[retry]\nsame_agent_attempts = 1\nagents = ["default", "deepseek"]\n\n[agents.CodexAgent]'
      ),
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
  const kimiHome = path.join(project, "kimi-api-home");

  const run = await startRun({
    projectRoot: project,
    runId: "kimi-api-environment",
    agent: "KimiAgent",
    env: {
      ...fakeSmithersEnv(project),
      SMITHERS_FAKE_KIMI_ENV_LOG: kimiEnvironmentLog,
      MOONSHOT_API_KEY: "moonshot-fallback-key",
      KIMI_BASE_URL: "https://kimi.example.invalid/v1",
      KIMI_CODE_HOME: kimiHome,
      KIMI_SHARE_DIR: kimiHome
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(
    fs.readFileSync(kimiEnvironmentLog, "utf8"),
    `|moonshot-fallback-key|https://kimi.example.invalid/v1|${kimiHome}|${kimiHome}|||\n`
  );
});

test("startRun submits the exact sealed redacted workflow input bytes", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const binDir = path.join(path.dirname(project), `${path.basename(project)}-redaction-bin`);
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
  const interpreter = path.join(path.dirname(project), `${path.basename(project)}-sealed-runner-interpreter`);
  fs.copyFileSync("/bin/sh", interpreter);
  fs.chmodSync(interpreter, 0o755);
  fs.writeFileSync(installed.target, `#!${interpreter}\nprintf '%s\\n' '{"ok":true}'\n`, "utf8");
  fs.chmodSync(installed.target, 0o755);
  const env = bindSmithersExecutableCapability(
    { PATH: "", SMITHERS_FAKE_LOG: path.join(project, "snapshot-anchor-cleanup.log") },
    installed.target,
    project
  );
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

test("native resume delegates the persisted workflow after mutable project sources are replaced", async () => {
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
  assert.equal(consumed.includes(`workflow=${mutableWorkflow}\n`), true);
  assert.match(consumed, /^config=.*\/smithers\/resolved-config\.json$/mu);
  assert.match(consumed, /^agent=.*\/\.smithers\/agents\/codex\.ts$/mu);
  assert.match(consumed, /HostileReplacement/u);
  assert.match(consumed, /export const hostile/u);
  assert.doesNotMatch(consumed, /^workflow=\/proc\//mu);
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

test("startRun ignores target-local Smithers in favor of an operator install", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const logPath = path.join(project, "local-smithers.log");
  const executedAsLogPath = path.join(project, "local-smithers-executed-as.log");
  writeFakeInstalledSmithers(project);
  writeFakeNpmInstaller(project);

  const run = await startRun({
    projectRoot: project,
    runId: "local-smithers-run",
    env: {
      PATH: "",
      SMITHERS_FAKE_LOG: logPath,
      SMITHERS_FAKE_EXECUTED_AS_LOG: executedAsLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(logPath, "utf8"), /up .*ultrafuzz-local-smithers-run\.tsx/);
  assert.equal(fs.existsSync(executedAsLogPath), false);
});

test("compatibility patcher rewrites every described workaround", async () => {
  const { applySmithersCompatibilityPatches, inspectSmithersInstallation, SMITHERS_COMPATIBILITY_PATCHES } =
    await import("../src/smithers.js");
  const project = tempProject();
  writeFakeInstalledSmithers(project);
  const nodeModules = path.join(project, ".smithers", "node_modules");
  const stockRunner = createRequire(import.meta.url).resolve("smthrs/bin/smithers");
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
    if (source.endsWith(SMITHERS_BIN_PATH)) {
      fs.cpSync(path.dirname(stockRunner), path.dirname(source), { recursive: true });
      continue;
    }
    fs.writeFileSync(source, `${anchors.join("\n")}\n`, "utf8");
  }

  {
    for (const id of ["process_snapshot_anchor", "resume_snapshot_transfer"] as const) {
      const startup = SMITHERS_COMPATIBILITY_PATCHES.find((patch) => patch.id === id);
      assert.ok(startup);
      assert.match(
        startup.patched,
        /"--env-file=\/proc\/self\/fd\/3\/controls\/bun-empty\.env".*"--no-addons".*"--preload=\/proc\/self\/fd\/3\/controls\/bun-module-confinement\.js"/u
      );
    }
    const relaunch = SMITHERS_COMPATIBILITY_PATCHES.find((patch) => patch.id === "manifest_relaunch");
    assert.ok(relaunch);
    assert.match(relaunch.patched, /relaunchSnapshotTransfer.*ultrafuzzBunStartupArgs.*descriptor/su);
    const lifecycle = SMITHERS_COMPATIBILITY_PATCHES.find((patch) => patch.id === "lifecycle_trace_summary");
    assert.ok(lifecycle);
    const patchableTypes = new Set([...lifecycle.patchable.matchAll(/"([A-Za-z]+)"/gu)].map((match) => match[1]!));
    const patchedTypes = [...lifecycle.patched.matchAll(/"([A-Za-z]+)"/gu)].map((match) => match[1]!);
    assert.deepEqual(
      patchedTypes.filter((type) => !patchableTypes.has(type)),
      ["AgentTraceSummary"],
      "the observability compatibility patch must expose only the bounded trace summary event"
    );
    assert.throws(
      () => bindSmithersExecutableCapability({}, stockRunner),
      /delegate controller authority to target code/u
    );
  }
  applySmithersCompatibilityPatches(project);
  const patchedRunner = sources.find(({ patch }) => patch.id === "local_delegation");
  assert.ok(patchedRunner);
  assert.equal(fs.statSync(patchedRunner.source).mode & 0o777, 0o500);
  for (const { patch, source } of sources) {
    // `patched` is the whole replacement text, so its presence is exactly the
    // statement "this workaround landed in the installed source".
    assert.equal(
      fs.readFileSync(source, "utf8").includes(patch.patched),
      true,
      `${patch.id} is described but was never applied to ${source}`
    );
  }
  {
    const resumeTransfer = sources.find(({ patch }) => patch.id === "resume_snapshot_transfer");
    assert.ok(resumeTransfer);
    const [predecessor] = resumeTransfer.patch.predecessors ?? [];
    assert.ok(predecessor);
    assert.notEqual(predecessor, resumeTransfer.patch.patched);
    const current = fs.readFileSync(resumeTransfer.source, "utf8");
    assert.equal(current.split(resumeTransfer.patch.patched).length, 2);
    fs.writeFileSync(resumeTransfer.source, current.replace(resumeTransfer.patch.patched, predecessor), "utf8");
    assert.equal(inspectSmithersInstallation(project).compatibility_patches.resume_snapshot_transfer, "missing");
    applySmithersCompatibilityPatches(project);
    assert.equal(fs.readFileSync(resumeTransfer.source, "utf8").includes(resumeTransfer.patch.patched), true);
    assert.equal(inspectSmithersInstallation(project).compatibility_patches.resume_snapshot_transfer, "applied");

    fs.writeFileSync(resumeTransfer.source, `${predecessor}\n${predecessor}\n`, "utf8");
    assert.equal(inspectSmithersInstallation(project).compatibility_patches.resume_snapshot_transfer, "incompatible");
    assert.throws(
      () => applySmithersCompatibilityPatches(project),
      /detached resume execution snapshot transfer implementation is incompatible/u
    );

    fs.writeFileSync(
      resumeTransfer.source,
      `${resumeTransfer.patch.patched}\n${resumeTransfer.patch.patchable}\n`,
      "utf8"
    );
    assert.equal(inspectSmithersInstallation(project).compatibility_patches.resume_snapshot_transfer, "incompatible");
    assert.throws(
      () => applySmithersCompatibilityPatches(project),
      /detached resume execution snapshot transfer implementation is incompatible/u
    );
    fs.writeFileSync(resumeTransfer.source, current, "utf8");
  }
  {
    const processAnchor = sources.find(({ patch }) => patch.id === "process_snapshot_anchor");
    assert.ok(processAnchor);
    const [predecessor, nested] = processAnchor.patch.predecessors ?? [];
    assert.ok(predecessor);
    assert.ok(nested);
    assert.equal(processAnchor.patch.predecessors?.length, 2);
    const current = fs.readFileSync(processAnchor.source, "utf8");
    assert.equal(current.split(processAnchor.patch.patched).length, 2);

    fs.writeFileSync(processAnchor.source, current.replace(processAnchor.patch.patched, predecessor), "utf8");
    assert.equal(inspectSmithersInstallation(project).compatibility_patches.process_snapshot_anchor, "missing");
    applySmithersCompatibilityPatches(project);
    const migratedPredecessor = fs.readFileSync(processAnchor.source, "utf8");
    assert.equal(migratedPredecessor.split(processAnchor.patch.patched).length, 2);
    assert.equal(migratedPredecessor.includes(nested), false);
    assert.equal(inspectSmithersInstallation(project).compatibility_patches.process_snapshot_anchor, "applied");

    fs.writeFileSync(processAnchor.source, current.replace(processAnchor.patch.patched, nested), "utf8");
    assert.equal(inspectSmithersInstallation(project).compatibility_patches.process_snapshot_anchor, "missing");
    applySmithersCompatibilityPatches(project);
    const migratedNested = fs.readFileSync(processAnchor.source, "utf8");
    assert.equal(migratedNested.split(processAnchor.patch.patched).length, 2);
    assert.equal(migratedNested.includes(nested), false);
    assert.equal(inspectSmithersInstallation(project).compatibility_patches.process_snapshot_anchor, "applied");

    const mutatedNested = nested.replace('"--preserve-symlinks"', '"--mutated-outer-startup-flag"');
    assert.notEqual(mutatedNested, nested);
    assert.equal(mutatedNested.includes(processAnchor.patch.patched), true);
    fs.writeFileSync(processAnchor.source, current.replace(processAnchor.patch.patched, mutatedNested), "utf8");
    assert.equal(inspectSmithersInstallation(project).compatibility_patches.process_snapshot_anchor, "incompatible");
    assert.throws(
      () => applySmithersCompatibilityPatches(project),
      /process-owned execution snapshot implementation is incompatible/u
    );

    const unknownPredecessor = predecessor.replace('"--preserve-symlinks"', '"--unregistered-startup-flag"');
    assert.notEqual(unknownPredecessor, predecessor);
    fs.writeFileSync(processAnchor.source, current.replace(processAnchor.patch.patched, unknownPredecessor), "utf8");
    assert.equal(inspectSmithersInstallation(project).compatibility_patches.process_snapshot_anchor, "incompatible");
    assert.throws(
      () => applySmithersCompatibilityPatches(project),
      /process-owned execution snapshot implementation is incompatible/u
    );
    fs.writeFileSync(processAnchor.source, current, "utf8");
  }
  {
    const delegation = sources.find(({ patch }) => patch.id === "local_delegation");
    assert.ok(delegation);
    const target = path.join(project, "hostile-target"),
      targetRunner = path.join(target, ".smithers", "node_modules", "smthrs", ...SMITHERS_BIN_PATH.split("/")),
      trustedMarker = path.join(project, "operator-cli-ran"),
      hostileMarker = path.join(project, "target-cli-ran"),
      cliRoot = path.join(nodeModules, "@smthrs", "cli");
    fs.mkdirSync(path.dirname(targetRunner), { recursive: true });
    fs.writeFileSync(
      path.join(cliRoot, "package.json"),
      `${JSON.stringify({ name: "@smthrs/cli", version: SMITHERS_VERSION, type: "module", exports: "./index.js" })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(cliRoot, "index.js"),
      `await Bun.write(process.env.ULTRAFUZZ_TRUSTED_MARKER, "trusted");\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(target, ".smithers", "node_modules", "smthrs", "package.json"),
      `${JSON.stringify({ name: "smthrs", version: SMITHERS_VERSION, type: "module", bin: { smithers: SMITHERS_BIN_PATH } })}\n`,
      "utf8"
    );
    fs.writeFileSync(targetRunner, `await Bun.write(process.env.ULTRAFUZZ_HOSTILE_MARKER, "hostile");\n`, "utf8");
    execFileSync(
      "bun",
      [
        `--config=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "--no-env-file",
        "--no-install",
        delegation.source,
        "inspect"
      ],
      {
        cwd: target,
        env: { ...process.env, ULTRAFUZZ_TRUSTED_MARKER: trustedMarker, ULTRAFUZZ_HOSTILE_MARKER: hostileMarker }
      }
    );
    assert.equal(fs.existsSync(trustedMarker), true);
    assert.equal(fs.existsSync(hostileMarker), false);
  }
});

// Keep creating the covering index for new databases. Do not force queries to
// use it: historical Smithers databases may predate the index and must remain
// resumable before any current startup migration runs.
test("event probe compatibility patch adds an optional covering index", async () => {
  const { SMITHERS_COMPATIBILITY_PATCHES } = await import("../src/smithers.js");
  const indexPatch = SMITHERS_COMPATIBILITY_PATCHES.find((patch) => patch.id === "event_probe_index");
  assert.ok(indexPatch);
  assert.match(indexPatch.patched, /CREATE INDEX IF NOT EXISTS _smithers_events_insert_probe_idx/u);
  assert.equal(
    SMITHERS_COMPATIBILITY_PATCHES.some((patch) =>
      patch.patched.includes("INDEXED BY _smithers_events_insert_probe_idx")
    ),
    false
  );
});

test("patched engine admits authenticated controller path changes without accepting VCS relocation", async () => {
  const { SMITHERS_COMPATIBILITY_PATCHES } = await import("../src/smithers.js");
  const resolveFromPinnedRunner = createRequire(
    fs.realpathSync(path.join(process.cwd(), "node_modules", "smthrs", "src", "index.js"))
  );
  const pinnedEngineSource = resolveFromPinnedRunner.resolve("@smthrs/engine/engine");
  const pinnedEngineRoot = path.dirname(path.dirname(pinnedEngineSource));
  const isolatedEngineRoot = path.join(tempProject(), "node_modules", "@smthrs", "engine");
  fs.mkdirSync(path.dirname(isolatedEngineRoot), { recursive: true });
  fs.cpSync(pinnedEngineRoot, isolatedEngineRoot, { recursive: true });
  fs.rmSync(path.join(isolatedEngineRoot, "node_modules"), { recursive: true, force: true });
  fs.symlinkSync(path.dirname(path.dirname(pinnedEngineRoot)), path.join(isolatedEngineRoot, "node_modules"), "dir");

  for (const patch of SMITHERS_COMPATIBILITY_PATCHES.filter(
    (candidate) => candidate.packageName === "@smthrs/engine"
  )) {
    const sourcePath = path.join(isolatedEngineRoot, ...patch.sourceRelativePath.split("/"));
    const source = fs.readFileSync(sourcePath, "utf8");
    assert.equal(
      source.split(patch.patchable).length,
      2,
      `${patch.id} does not uniquely anchor in the isolated pinned engine`
    );
    fs.writeFileSync(sourcePath, source.replace(patch.patchable, patch.patched), "utf8");
  }

  const patchedEngine = (await import(pathToFileURL(path.join(isolatedEngineRoot, "src", "engine.js")).href)) as {
    __engineInternals: {
      assertResumeDurabilityMetadata: (
        existingRun: Record<string, unknown>,
        existingConfig: Record<string, unknown>,
        current: Record<string, unknown>,
        workflowPath: string,
        options?: { acceptWorkflowChange?: boolean }
      ) => string[];
    };
  };
  const admit = patchedEngine.__engineInternals.assertResumeDurabilityMetadata;
  const generationZero = "0".repeat(64);
  const generationOne = "1".repeat(64);
  const snapshotParent = path.join(tempProject(), "execution-snapshots");
  const originalWorkflow = path.join(snapshotParent, generationZero, ".smithers", "workflows", "workflow.tsx");
  const refreshedWorkflow = path.join(snapshotParent, generationOne, ".smithers", "workflows", "workflow.tsx");
  const existingRun = {
    workflowPath: originalWorkflow,
    workflowHash: "graph-v1",
    vcsType: "git",
    vcsRoot: "/synthetic/repository",
    vcsRevision: "revision-one"
  };
  const existingConfig = {
    __smithersDurability: { version: 2, entryWorkflowHash: "entry-v1" }
  };
  const refreshedMetadata = {
    workflowHash: "graph-v2",
    entryWorkflowHash: "entry-v2",
    vcsType: "git",
    vcsRoot: "/synthetic/repository",
    vcsRevision: "revision-one"
  };

  assert.throws(
    () => admit(existingRun, existingConfig, refreshedMetadata, refreshedWorkflow),
    (error: unknown) => {
      const mismatch = error as { code?: unknown; details?: { mismatches?: unknown } };
      assert.equal(mismatch.code, "RESUME_METADATA_MISMATCH");
      assert.deepEqual(mismatch.details?.mismatches, [
        "workflow path changed",
        "workflow module graph changed",
        "workflow entry file changed"
      ]);
      return true;
    }
  );
  assert.deepEqual(
    admit(existingRun, existingConfig, refreshedMetadata, refreshedWorkflow, { acceptWorkflowChange: true }),
    ["workflow path changed", "workflow module graph changed", "workflow entry file changed"]
  );
  assert.throws(
    () =>
      admit(
        existingRun,
        existingConfig,
        { ...refreshedMetadata, vcsRoot: "/synthetic/other-repository" },
        refreshedWorkflow,
        { acceptWorkflowChange: true }
      ),
    (error: unknown) => {
      const mismatch = error as { code?: unknown; details?: { mismatches?: unknown } };
      assert.equal(mismatch.code, "RESUME_METADATA_MISMATCH");
      assert.deepEqual(mismatch.details?.mismatches, ["VCS root changed"]);
      return true;
    }
  );
});

testWhen(process.platform !== "win32" && fs.existsSync("/proc/self/fd"))(
  "the patched runner admits engine and supervisor process-owned execution snapshot descriptors",
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

testWhen(process.platform !== "win32" && fs.existsSync("/proc/self/fd"))(
  "sealed module confinement canonicalizes valid descriptor aliases and rejects outside or reused descriptors",
  async () => {
    // Descriptor aliases are resolved and checked before loading. Owning an
    // outside descriptor, or reusing a formerly valid number, grants nothing.
    const root = tempProject();
    const controls = path.join(root, "controls");
    fs.mkdirSync(controls, { recursive: true });
    fs.writeFileSync(path.join(controls, "bunfig.toml"), "\n", "utf8");
    fs.writeFileSync(path.join(controls, "bun-empty.env"), "\n", "utf8");
    fs.writeFileSync(path.join(controls, "bun-module-confinement.js"), BUN_MODULE_CONFINEMENT_SOURCE, "utf8");
    fs.writeFileSync(path.join(root, "sealed-helper.mjs"), 'export const value = "sealed";\n', "utf8");
    const outsideRoot = tempProject();
    const ambientPath = path.join(outsideRoot, "ambient.mjs");
    fs.writeFileSync(ambientPath, 'export default "ambient";\n', "utf8");
    const dependencyRoot = path.join(root, "dependencies", "sealed-package");
    const ambientDependencyRoot = path.join(outsideRoot, "ambient-package");
    fs.mkdirSync(dependencyRoot, { recursive: true });
    fs.mkdirSync(ambientDependencyRoot, { recursive: true });
    fs.writeFileSync(
      path.join(dependencyRoot, "package.json"),
      `${JSON.stringify({ name: "sealed-package", main: "index.cjs" })}\n`,
      "utf8"
    );
    fs.writeFileSync(path.join(dependencyRoot, "index.cjs"), 'module.exports = { packageValue: "package" };\n', "utf8");
    fs.writeFileSync(
      path.join(ambientDependencyRoot, "package.json"),
      `${JSON.stringify({ name: "ambient-package", type: "module", exports: "./index.js" })}\n`,
      "utf8"
    );
    fs.writeFileSync(path.join(ambientDependencyRoot, "index.js"), 'export default "ambient-package";\n', "utf8");
    // Decoys under the probe's working directory: #794 shipped broken because its probe ran with
    // cwd inside the sealed root, so a cwd-fallback resolution passed by coincidence. If sealed
    // imports ever consult the cwd again, they find these and the value assertions fail.
    fs.writeFileSync(path.join(outsideRoot, "sealed-helper.mjs"), 'export const value = "cwd-decoy";\n', "utf8");
    const decoyDependencyRoot = path.join(outsideRoot, "node_modules", "sealed-package");
    fs.mkdirSync(decoyDependencyRoot, { recursive: true });
    fs.writeFileSync(
      path.join(decoyDependencyRoot, "package.json"),
      `${JSON.stringify({ name: "sealed-package", main: "index.cjs" })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(decoyDependencyRoot, "index.cjs"),
      'module.exports = { packageValue: "cwd-decoy" };\n',
      "utf8"
    );
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.symlinkSync(
      path.relative(path.join(root, "node_modules"), dependencyRoot),
      path.join(root, "node_modules", "sealed-package")
    );
    fs.symlinkSync(
      path.relative(path.join(root, "node_modules"), ambientDependencyRoot),
      path.join(root, "node_modules", "ambient-package")
    );
    fs.writeFileSync(
      path.join(root, "sealed.tsx"),
      'import { value } from "./sealed-helper.mjs"; import { packageValue } from "sealed-package"; const typed: string = `${value}:${packageValue}`; let ambientRejected = false; try { await import("ambient-package"); } catch { ambientRejected = true; } export default { value: typed, ambientRejected };\n',
      "utf8"
    );

    const scriptPath = path.join(root, "second-descriptor-probe.mjs");
    fs.writeFileSync(
      scriptPath,
      `import { closeSync, openSync } from "node:fs";
const sealedDescriptor = openSync(${JSON.stringify(root)}, "r");
const sealed = await import("/proc/" + process.pid + "/fd/" + sealedDescriptor + "/sealed.tsx");
const ambientDescriptor = openSync(${JSON.stringify(outsideRoot)}, "r");
let ambientRejected = false;
try {
  await import("/proc/" + process.pid + "/fd/" + ambientDescriptor + "/ambient.mjs");
} catch {
  ambientRejected = true;
}
closeSync(sealedDescriptor);
const reusedDescriptor = openSync(${JSON.stringify(outsideRoot)}, "r");
if (reusedDescriptor !== sealedDescriptor) throw new Error("fixture did not reuse the descriptor");
let reusedRejected = false;
try {
  await import("/proc/" + process.pid + "/fd/" + reusedDescriptor + "/ambient.mjs?reused");
} catch {
  reusedRejected = true;
}
process.stdout.write(JSON.stringify({ sealed: sealed.default, ambientRejected, reusedRejected }));
`,
      "utf8"
    );

    const probe = spawnSync(
      "bun",
      [
        `--config=${path.join(controls, "bunfig.toml")}`,
        `--env-file=${path.join(controls, "bun-empty.env")}`,
        "--no-env-file",
        "--no-install",
        "--no-addons",
        "--preserve-symlinks-main",
        `--preload=${path.join(controls, "bun-module-confinement.js")}`,
        scriptPath
      ],
      // The working directory deliberately sits outside the sealed root, where the decoys live:
      // resolution must come from the sealed module's own tree, never from the cwd.
      { encoding: "utf8", cwd: outsideRoot }
    );

    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), {
      sealed: { value: "sealed:package", ambientRejected: true },
      ambientRejected: true,
      reusedRejected: true
    });
  }
);

testWhen(process.platform !== "win32" && fs.existsSync("/proc/self/fd"))(
  "fixed fd transfer survives parent exit and fd reuse across Bun engine, supervisor, and resume",
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
    const ambientName = `ufz-ambient-${path.basename(root)}`,
      ambientRoot = path.join(os.tmpdir(), "node_modules", ambientName),
      ambientMarker = path.join(coordinationRoot, "ambient-ran");
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(workflowPath, "sealed-workflow\n", "utf8");
    fs.writeFileSync(configPath, "sealed-config\n", "utf8");
    {
      fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(root, "controls", "bunfig.toml"), "\n", "utf8");
      fs.writeFileSync(path.join(root, "controls", "bun-empty.env"), "\n", "utf8");
      fs.writeFileSync(path.join(root, "controls", "bun-module-confinement.js"), BUN_MODULE_CONFINEMENT_SOURCE, "utf8");
      fs.writeFileSync(path.join(root, "sealed-relative.mjs"), 'export default "sealed-relative";\n', "utf8");
      fs.mkdirSync(ambientRoot, { recursive: true });
      fs.writeFileSync(
        path.join(ambientRoot, "package.json"),
        `${JSON.stringify({ name: ambientName, type: "module", exports: "./index.js" })}\n`
      );
      fs.writeFileSync(
        path.join(ambientRoot, "index.js"),
        `await Bun.write(${JSON.stringify(ambientMarker)}, "hostile");\n`
      );
    }
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
function waitForParentHandoff(parentPid, resultPath) { const deadline = Date.now() + 10_000; for (;;) { let alive = true; try { process.kill(parentPid, 0); } catch { alive = false; } if (!alive && existsSync(process.env.UFZ_GO_PATH)) return; if (Date.now() >= deadline) { writeFileSync(resultPath, JSON.stringify({ error: "parent-handoff-timeout" })); process.exit(81); } sleep(10); } }

async function moduleProbe() { const relativeModule = await import("./sealed-relative.mjs"); let ambientError; try { await import(${JSON.stringify(ambientName)}); } catch (error) { ambientError = String(error); } return { relative_module: relativeModule.default, ambient_error: ambientError }; }

function evidence(workflowArgument) {
  return {
    pid: process.pid,
    parent_pid: process.ppid,
    process_descriptor: Number(process.env.ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR),
    process_root: process.env.ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT,
    source_root: process.env.ULTRAFUZZ_SNAPSHOT_SOURCE_ROOT,
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
  const args = [fileURLToPath(new URL("./descriptor-generations.mjs", import.meta.url)), phase, process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH];
  const cwd = process.cwd();
  const options = {};
  const logFd = withLog ? openSync(process.env.UFZ_LOG_PATH, "a") : null;
  try {
${resumeTransferPatch.patched}
    child.unref();
    return { pid: child.pid, args: args.map(rewriteSnapshotArgument) };
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
  waitForParentHandoff(Number(process.env.UFZ_PARENT_PID), process.env.UFZ_SUPERVISOR_RECORD_PATH);
  const modules = await moduleProbe();
  process.env.UFZ_PARENT_PID = String(process.pid);
  const ownEvidence = evidence(undefined);
  const logged = launchResume("resume-logged", true);
  const ignored = launchResume("resume-ignored", false);
  const reusedDescriptor = closeAndReuseProcessDescriptor();
  writeFileSync(process.env.UFZ_RESUME_LAUNCH_PATH, JSON.stringify({ logged: logged.args, ignored: ignored.args }));
  writeFileSync(
    process.env.UFZ_SUPERVISOR_RECORD_PATH,
    JSON.stringify({ ...ownEvidence, ...modules, logged_pid: logged.pid, ignored_pid: ignored.pid, reused_descriptor: reusedDescriptor })
  );
  process.exit(0);
}

if (phase === "engine" || phase === "resume-logged" || phase === "resume-ignored") {
  const resultPath = phase === "engine"
    ? process.env.UFZ_ENGINE_RESULT_PATH
    : phase === "resume-logged"
      ? process.env.UFZ_LOGGED_RESUME_RESULT_PATH
      : process.env.UFZ_IGNORED_RESUME_RESULT_PATH;
  waitForParentHandoff(Number(process.env.UFZ_PARENT_PID), resultPath);
  try {
    const modules = await moduleProbe();
    writeFileSync(
      resultPath,
      JSON.stringify({
        phase,
        ...evidence(workflowArgument),
        ...modules,
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
        "ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT",
        "ULTRAFUZZ_SNAPSHOT_SOURCE_ROOT"
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
      assertInheritedSnapshotEvidence(JSON.parse(anchoredProbe.stdout) as TransferEvidence);

      const launcher = spawnSync(
        "bun",
        [
          `--config=${path.join(controllerRoot, "controls", "bunfig.toml")}`,
          `--env-file=${path.join(controllerRoot, "controls", "bun-empty.env")}`,
          "--no-env-file",
          "--no-install",
          "--no-addons",
          "--preserve-symlinks-main",
          `--preload=${path.join(controllerRoot, "controls", "bun-module-confinement.js")}`,
          path.join(controllerRoot, path.basename(scriptPath)),
          "launcher",
          controllerWorkflowPath
        ],
        { cwd: root, encoding: "utf8", timeout: 10_000, env: fixtureEnvironment }
      );
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
      assertInheritedSnapshotEvidence(supervisorEvidence);
      assert.equal(supervisorEvidence.reused_descriptor, supervisorEvidence.process_descriptor);
      assert.equal(supervisorEvidence.relative_module, "sealed-relative");
      assert.match(String(supervisorEvidence.ambient_error), /outside its sealed snapshot/u);
      addEvidencePids(pids, supervisorEvidence, "logged_pid", "ignored_pid");

      const resumeLaunch = JSON.parse(fs.readFileSync(resumeLaunchPath, "utf8")) as {
        logged?: string[];
        ignored?: string[];
      };
      const resumeEntrypoint = "/proc/self/fd/3/descriptor-generations.mjs";
      const resumeWorkflow = "/proc/self/fd/3/.smithers/workflows/fd-transfer.tsx";
      assert.deepEqual(resumeLaunch.logged, [resumeEntrypoint, "resume-logged", resumeWorkflow]);
      assert.deepEqual(resumeLaunch.ignored, [resumeEntrypoint, "resume-ignored", resumeWorkflow]);

      for (const resultPath of [engineResultPath, loggedResumeResultPath, ignoredResumeResultPath]) {
        const result = readTransferEvidence(resultPath);
        assert.equal(result.error, undefined);
        assertInheritedSnapshotEvidence(result);
        assert.equal(result.config, "sealed-config\n");
        assert.equal(result.workflow, "sealed-workflow\n");
        assert.equal(result.relative_module, "sealed-relative");
        assert.match(String(result.ambient_error), /outside its sealed snapshot/u);
        assert.match(result.workflow_path ?? "", new RegExp(`^/proc/${result.pid}/fd/\\d+/.smithers/workflows/`, "u"));
        if (result.pid !== undefined) pids.add(result.pid);
      }
      assert.equal(fs.existsSync(ambientMarker), false);
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
      fs.rmSync(ambientRoot, { recursive: true, force: true });
    }
  }
);

type TransferEvidence = {
  error?: string;
  pid?: number;
  process_descriptor?: number;
  process_root?: string;
  source_root?: string;
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
  assert.equal(typeof evidence.source_root, "string");
  assert.equal(evidence.inherited_descriptor_present, false);
  assert.match(
    evidence.config_path ?? "",
    new RegExp(`^/proc/${evidence.pid}/fd/\\d+/controls/ultrafuzz\\.toml$`, "u")
  );
  assert.equal(evidence.monitor_suppressed, "1");
  assert.equal(evidence.autopsy_suppressed, "0");
}

function assertInheritedSnapshotEvidence(evidence: TransferEvidence): void {
  assertProcessOwnedSnapshotEvidence(evidence);
  assert.equal(evidence.process_descriptor, 3);
  assert.equal(evidence.source_root, "/proc/self/fd/3");
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
    const predecessors = patch.predecessors ?? [];
    assert.equal(new Set(predecessors).size, predecessors.length, `${label} repeats a predecessor replacement`);
    for (const predecessor of predecessors) {
      assert.notEqual(predecessor, patch.patchable, `${label} predecessor duplicates pristine source`);
      assert.notEqual(predecessor, patch.patched, `${label} predecessor duplicates the current replacement`);
      assert.equal(
        patch.patched.includes(predecessor),
        false,
        `${label} current replacement contains a predecessor and cannot be classified unambiguously`
      );
    }
    for (const marker of patch.patchedFamilyMarkers ?? []) {
      assert.equal(patch.upstreamAbsent.includes(marker), true, `${label} family marker is not absent upstream`);
      assert.equal(patch.patched.includes(marker), true, `${label} current replacement omits its family marker`);
      for (const predecessor of predecessors) {
        assert.equal(predecessor.includes(marker), true, `${label} predecessor omits its family marker`);
      }
    }
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

test("startRun rejects an explicit project-local Smithers bin with a leading dot target", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const logPath = path.join(project, "published-smithers.log");
  const installed = writeFakeInstalledSmithers(project, { binTarget: `./${SMITHERS_BIN_PATH}` });

  const run = await startRun({
    projectRoot: project,
    runId: "published-smithers-bin-run",
    env: { PATH: "", SMITHERS_BIN: installed.shim, SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, false);
  assert.match(JSON.stringify(run.diagnostics), /workflow runner cannot .*inside the target project/u);
  assert.equal(fs.existsSync(logPath), false);
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

test("startRun rejects an explicitly selected project-local package-manager entrypoint", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const logPath = path.join(project, "pnpm-smithers.log");
  const paths = writeFakePnpmInstalledSmithers(project);

  const run = await startRun({
    projectRoot: project,
    runId: "pnpm-smithers-run",
    env: { PATH: "", SMITHERS_BIN: paths.target, SMITHERS_FAKE_LOG: logPath }
  });

  assert.equal(run.ok, false);
  assert.equal(fs.realpathSync(paths.packageRoot).includes(`${path.sep}.pnpm${path.sep}`), true);
  assert.match(JSON.stringify(run.diagnostics), /workflow runner cannot .*inside the target project/u);
  assert.equal(fs.existsSync(logPath), false);
});

test("startRun installs, seals, and revalidates operator-owned Smithers", async (t) => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);

  const injectedName = `ufz-parent-${path.basename(project)}`,
    injectedRoot = path.join(os.tmpdir(), "node_modules", injectedName),
    injectedMarker = path.join(injectedRoot, "executed");
  fs.mkdirSync(injectedRoot, { recursive: true });
  fs.writeFileSync(
    path.join(injectedRoot, "package.json"),
    `${JSON.stringify({ name: injectedName, version: "1.0.0", main: "index.js" })}\n`
  );
  fs.writeFileSync(
    path.join(injectedRoot, "index.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(injectedMarker)}, "executed");\n`
  );
  t.after(() => fs.rmSync(injectedRoot, { recursive: true, force: true }));
  const installer = writeFakeNpmInstaller(project, { count: 0, stderr: [], imported: injectedName });

  const run = await startRun({
    projectRoot: project,
    runId: "bootstrap-smithers-run",
    env: {
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /install .*--prefix .*\.smithers/);
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /--ignore-scripts/);
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /--package-lock=true/);
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /--registry=https:\/\/registry\.npmjs\.org/);
  assert.equal(fs.readFileSync(installer.npmLogPath, "utf8").includes(project), false);
  assert.match(fs.readFileSync(installer.smithersLogPath, "utf8"), /up .*ultrafuzz-bootstrap-smithers-run\.tsx/);
  assert.equal(fs.existsSync(injectedMarker), false);
  {
    const requiredInstaller = writeFakeNpmInstaller(project, { count: 0, stderr: [], required: injectedName }),
      missing = await startRun({
        projectRoot: project,
        runId: "controller-parent-required",
        env: { SMITHERS_FAKE_LOG: requiredInstaller.smithersLogPath }
      });
    assert.equal(missing.ok, false);
    assert.match(JSON.stringify(missing.diagnostics), /dependency is unavailable/u);
  }
  {
    const packageRoot = fs.readFileSync(installer.npmLogPath, "utf8").match(/--prefix (\S+)/u)?.[1];
    assert.ok(packageRoot);
    fs.appendFileSync(path.join(packageRoot, "node_modules", "smthrs", "index.js"), "// hostile\n");
    installer.activate();
    const tampered = await startRun({
      projectRoot: project,
      runId: "controller-cache-tamper",
      env: { SMITHERS_FAKE_LOG: installer.smithersLogPath }
    });
    assert.equal(tampered.ok, false);
    assert.match(JSON.stringify(tampered.diagnostics), /operator controller changed after installation/u);
  }
});

test("operator controller locks require a canonical 64-byte SHA-512 integrity", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const installer = writeFakeNpmInstaller(project, { count: 0, stderr: [], integrity: "sha512-A" });
  const run = await startRun({
    projectRoot: project,
    runId: "short-controller-integrity",
    env: { SMITHERS_FAKE_LOG: installer.smithersLogPath }
  });
  assert.equal(run.ok, false);
  assert.match(JSON.stringify(run.diagnostics), /not registry-integrity bound/u);
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

test("startRun ignores a stale target-local Smithers package", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  writeFakeInstalledSmithers(project, { version: "0.26.0" });
  const installer = writeFakeNpmInstaller(project);

  const run = await startRun({
    projectRoot: project,
    runId: "stale-smithers-run",
    env: {
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /install/u);
  const installed = JSON.parse(fs.readFileSync(fakeInstalledSmithersPaths(project).packageJson, "utf8")) as {
    version: string;
  };
  assert.equal(installed.version, "0.26.0");
});

test("startRun ignores a target-local Smithers shim that points outside the pinned package", async () => {
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
      SMITHERS_FAKE_LOG: installer.smithersLogPath
    }
  });

  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.match(fs.readFileSync(installer.npmLogPath, "utf8"), /install/u);
  assert.equal(fs.realpathSync(paths.shim), fs.realpathSync(wrongTarget));
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

  const binDir = path.join(path.dirname(project), `${path.basename(project)}-log-dir-bin`);
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

  const binDir = path.join(path.dirname(project), `${path.basename(project)}-failed-submit-bin`);
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
    provenance?: { metadata?: unknown; verification_marker_sha256?: string };
  };
  assert.equal(manifest.schema_version, "ultrafuzz.artifact-manifest.v3");
  assert.deepEqual(manifest.provenance?.metadata, { concrete_node_id: "project-discovery" });
  assert.equal(
    manifest.provenance?.verification_marker_sha256,
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(run.value!.run_root, ".ultrafuzz-verification", "project-discovery.json")))
      .digest("hex")
  );
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
  // Leave enough headroom for a contended hosted runner while still proving
  // that the child exits before the five-second forced-kill grace period.
  const responsiveTerminationBudgetMs = 4_000;
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const binDir = path.join(path.dirname(project), `${path.basename(project)}-blocked-bin`);
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  const inspectionStartedMarker = path.join(project, "inspection-started");
  fs.writeFileSync(
    smithers,
    `#!${process.execPath}
if (process.argv[2] === "inspect") {
  require("node:fs").writeFileSync(${JSON.stringify(inspectionStartedMarker)}, String(Date.now()));
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
  let abortIssuedAt: number | undefined;
  const abortPoll = setInterval(() => {
    if (abortIssuedAt !== undefined || !fs.existsSync(inspectionStartedMarker)) return;
    clearInterval(abortPoll);
    abortIssuedAt = Date.now();
    controller.abort();
  }, 10);
  let abortFallbackFired = false;
  const abortFallback = setTimeout(() => {
    abortFallbackFired = true;
    controller.abort();
  }, 60_000);
  const cancelled = await (async () => {
    try {
      return await syncRun({ projectRoot: project, runId: "sync-blocked-child", env }, { signal: controller.signal });
    } finally {
      clearInterval(abortPoll);
      clearTimeout(abortFallback);
    }
  })();
  assert.equal(cancelled.ok, false);
  assert.ok(cancelled.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_CANCELLED"));
  assert.equal(abortFallbackFired, false);
  assert.notEqual(abortIssuedAt, undefined);
  assert.ok(Date.now() - abortIssuedAt! < responsiveTerminationBudgetMs);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);

  fs.rmSync(inspectionStartedMarker, { force: true });
  const deadlineRun = await startRun({ projectRoot: project, runId: "sync-blocked-deadline", env });
  assert.equal(deadlineRun.ok, true, JSON.stringify(deadlineRun.diagnostics));
  const deadlineStatePath = path.join(deadlineRun.value!.run_root, "state.json");
  const deadlineStateBefore = fs.readFileSync(deadlineStatePath, "utf8");
  const deadlineClock = 1_000;
  const inspectionTimeoutMs = 5_000;
  const expired = await syncRun(
    { projectRoot: project, runId: "sync-blocked-deadline", env },
    {
      deadlineMs: deadlineClock + inspectionTimeoutMs,
      now: () => (fs.existsSync(inspectionStartedMarker) ? deadlineClock + inspectionTimeoutMs : deadlineClock)
    }
  );
  assert.equal(expired.ok, false);
  assert.ok(
    expired.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED"),
    JSON.stringify(expired.diagnostics)
  );
  assert.equal(fs.existsSync(inspectionStartedMarker), true);
  const inspectionStartedAt = Number(fs.readFileSync(inspectionStartedMarker, "utf8"));
  assert.ok(Date.now() - inspectionStartedAt < inspectionTimeoutMs * 2);
  assert.equal(fs.readFileSync(deadlineStatePath, "utf8"), deadlineStateBefore);
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

test("syncRun succeeds when only an explicitly nonblocking specialist fails", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOptionalSpecialistTopology(project);
  const workflowRunId = "ultrafuzz-sync-optional-specialist-failure";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [
        { id: "node:direct-strategy", state: "finished", attempt: 1 },
        { id: "node:optional-specialist", state: "failed", attempt: 1 },
        { id: "node:final-report", state: "finished", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeFinished", nodeId: "node:direct-strategy", attempt: 1 },
      {
        type: "NodeFailed",
        nodeId: "node:optional-specialist",
        attempt: 1,
        error: { message: "optional specialist failed" }
      },
      { type: "NodeFinished", nodeId: "node:final-report", attempt: 1 },
      { type: "RunFinished" }
    ])
  });
  const run = await startRun({ projectRoot: project, runId: "sync-optional-specialist-failure", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "direct-strategy", [GENERIC_RUNTIME_MARKDOWN_PATH]);
  writeRequiredArtifactSet(run.value!.run_root, "final-report", [GENERIC_RUNTIME_MARKDOWN_PATH]);

  const sync = await syncRun({ projectRoot: project, runId: "sync-optional-specialist-failure", env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "succeeded", JSON.stringify(sync.diagnostics));
  const state = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as {
    nodes?: Record<string, { status?: string }>;
  };
  assert.equal(state.nodes?.["direct-strategy"]?.status, "succeeded");
  assert.equal(state.nodes?.["optional-specialist"]?.status, "failed");
  assert.equal(state.nodes?.["final-report"]?.status, "succeeded");
});

for (const markerAuthority of ["malformed leaf", "dangling leaf", "symlinked root"] as const) {
  test(`syncRun rejects a finalized optional prerequisite behind a ${markerAuthority}`, async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeOptionalSpecialistTopology(project);
    const workflowRunId = `ultrafuzz-sync-optional-${markerAuthority.replaceAll(" ", "-")}`;
    const upstreamEvents = [
      { type: "NodeFinished", nodeId: "node:direct-strategy", attempt: 1 },
      { type: "NodeFinished", nodeId: "node:optional-specialist", attempt: 1 }
    ];
    const upstreamEnv = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId,
        status: "running",
        steps: [
          { id: "node:direct-strategy", state: "finished", attempt: 1 },
          { id: "node:optional-specialist", state: "finished", attempt: 1 },
          { id: "node:final-report", state: "pending", attempt: 0 }
        ]
      }),
      events: workflowEvents(workflowRunId, upstreamEvents)
    });
    const runId = `sync-optional-${markerAuthority.replaceAll(" ", "-")}`;
    const run = await startRun({ projectRoot: project, runId, env: upstreamEnv });
    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    const runRoot = run.value!.run_root;
    writeRequiredArtifactSet(runRoot, "direct-strategy", [GENERIC_RUNTIME_MARKDOWN_PATH]);
    writeRequiredArtifactSet(runRoot, "optional-specialist", [GENERIC_RUNTIME_MARKDOWN_PATH]);

    const upstreamSync = await syncRun({ projectRoot: project, runId, env: upstreamEnv });
    assert.equal(upstreamSync.ok, true, JSON.stringify(upstreamSync.diagnostics));
    assert.equal(fs.existsSync(path.join(runRoot, "artifacts", "optional-specialist", "artifact-manifest.json")), true);

    const markerRoot = path.join(runRoot, ".ultrafuzz-verification");
    const optionalMarker = path.join(markerRoot, "optional-specialist.json");
    if (markerAuthority === "malformed leaf") {
      fs.writeFileSync(optionalMarker, "{}\n", "utf8");
    } else if (markerAuthority === "dangling leaf") {
      fs.unlinkSync(optionalMarker);
      fs.symlinkSync("missing-optional-marker.json", optionalMarker);
    } else {
      const realMarkerRoot = path.join(runRoot, "verification-authority-real");
      fs.renameSync(markerRoot, realMarkerRoot);
      fs.symlinkSync(realMarkerRoot, markerRoot, "dir");
    }
    writeRequiredArtifactSet(runRoot, "final-report", [GENERIC_RUNTIME_MARKDOWN_PATH]);

    const finalEvents = [
      ...upstreamEvents,
      { type: "NodeFinished", nodeId: "node:final-report", attempt: 1 },
      { type: "RunFinished" }
    ];
    const finalEnv = fakeLifecycleSmithersEnv(project, {
      inspect: workflowInspect({
        workflowRunId,
        steps: [
          { id: "node:direct-strategy", state: "finished", attempt: 1 },
          { id: "node:optional-specialist", state: "finished", attempt: 1 },
          { id: "node:final-report", state: "finished", attempt: 1 }
        ]
      }),
      events: workflowEvents(workflowRunId, finalEvents)
    });
    const sync = await syncRun({ projectRoot: project, runId, env: finalEnv });

    assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
    assert.equal(sync.value?.status, "failed", JSON.stringify(sync.diagnostics));
    assert.ok(
      sync.diagnostics.some((diagnostic) =>
        ["ARTIFACT_MANIFEST_WRITE_FAILED", "ARTIFACT_VERIFICATION_AUTHORITY_INVALID"].includes(diagnostic.code)
      ),
      JSON.stringify(sync.diagnostics)
    );
    assert.equal(fs.existsSync(path.join(runRoot, "artifacts", "final-report", "artifact-manifest.json")), false);
  });
}

test("syncRun binds an optional prerequisite digest before a final-boundary manifest swap", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeOptionalSpecialistTopology(project);
  const workflowRunId = "ultrafuzz-sync-optional-manifest-swap";
  const upstreamEvents = [
    { type: "NodeFinished", nodeId: "node:direct-strategy", attempt: 1 },
    { type: "NodeFinished", nodeId: "node:optional-specialist", attempt: 1 }
  ];
  const upstreamEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      steps: [
        { id: "node:direct-strategy", state: "finished", attempt: 1 },
        { id: "node:optional-specialist", state: "finished", attempt: 1 },
        { id: "node:final-report", state: "pending", attempt: 0 }
      ]
    }),
    events: workflowEvents(workflowRunId, upstreamEvents)
  });
  const runId = "sync-optional-manifest-swap";
  const run = await startRun({ projectRoot: project, runId, env: upstreamEnv });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const runRoot = run.value!.run_root;
  writeRequiredArtifactSet(runRoot, "direct-strategy", [GENERIC_RUNTIME_MARKDOWN_PATH]);
  writeRequiredArtifactSet(runRoot, "optional-specialist", [GENERIC_RUNTIME_MARKDOWN_PATH]);
  const upstreamSync = await syncRun({ projectRoot: project, runId, env: upstreamEnv });
  assert.equal(upstreamSync.ok, true, JSON.stringify(upstreamSync.diagnostics));

  const optionalManifestPath = path.join(runRoot, "artifacts", "optional-specialist", "artifact-manifest.json");
  const optionalManifestBytes = fs.readFileSync(optionalManifestPath);
  const optionalManifestSha256 = crypto.createHash("sha256").update(optionalManifestBytes).digest("hex");
  const swappedManifestBytes = Buffer.concat([optionalManifestBytes, Buffer.from("\n")]);
  const finalReportArtifactDir = path.join(runRoot, "artifacts", "final-report");
  writeRequiredArtifactSet(runRoot, "final-report", [GENERIC_RUNTIME_MARKDOWN_PATH]);
  const finalEvents = [
    ...upstreamEvents,
    { type: "NodeFinished", nodeId: "node:final-report", attempt: 1 },
    { type: "RunFinished" }
  ];
  const finalEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [
        { id: "node:direct-strategy", state: "finished", attempt: 1 },
        { id: "node:optional-specialist", state: "finished", attempt: 1 },
        { id: "node:final-report", state: "finished", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, finalEvents)
  });

  const readdirSyncDescriptor = Object.getOwnPropertyDescriptor(fs, "readdirSync")!;
  const openSyncDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
  const originalReaddirSync = fs.readdirSync;
  const originalOpenSync = fs.openSync;
  let manifestConstructionStarted = false;
  let swapped = false;
  Object.defineProperty(fs, "readdirSync", {
    ...readdirSyncDescriptor,
    value: ((directory: fs.PathLike, options?: unknown) => {
      if (path.resolve(String(directory)) === finalReportArtifactDir) manifestConstructionStarted = true;
      return originalReaddirSync(directory, options as never);
    }) as typeof fs.readdirSync
  });
  Object.defineProperty(fs, "openSync", {
    ...openSyncDescriptor,
    value: ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (manifestConstructionStarted && !swapped && path.resolve(String(file)) === optionalManifestPath) {
        swapped = true;
        fs.writeFileSync(optionalManifestPath, swappedManifestBytes);
      }
      return originalOpenSync(file, flags, mode);
    }) as typeof fs.openSync
  });
  let sync: Awaited<ReturnType<typeof syncRun>>;
  try {
    sync = await syncRun({ projectRoot: project, runId, env: finalEnv });
  } finally {
    Object.defineProperty(fs, "openSync", openSyncDescriptor);
    Object.defineProperty(fs, "readdirSync", readdirSyncDescriptor);
  }

  assert.equal(swapped, true, "the optional manifest must be swapped after prerequisite capture");
  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "failed", JSON.stringify(sync.diagnostics));
  assert.ok(
    sync.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_MANIFEST_WRITE_FAILED"),
    JSON.stringify(sync.diagnostics)
  );
  const consumerManifest = JSON.parse(
    fs.readFileSync(path.join(finalReportArtifactDir, "artifact-manifest.json"), "utf8")
  ) as { prerequisite_manifests: Array<{ node_id: string; sha256: string }> };
  assert.equal(
    consumerManifest.prerequisite_manifests.find((entry) => entry.node_id === "optional-specialist")?.sha256,
    optionalManifestSha256,
    "the consumer must use the captured state-pinned digest instead of rereading the swapped manifest"
  );
  assert.notEqual(optionalManifestSha256, crypto.createHash("sha256").update(swappedManifestBytes).digest("hex"));
});

test("syncRun maps failed workflow nodes into durable failed run state", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace("[agents.CodexAgent]", "[retry]\nsame_agent_attempts = 2\n\n[agents.CodexAgent]"),
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

test("syncRun keeps redacted failure state and attempt evidence stable across credential rotation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-rotated-credential";
  const workflowRunId = "ultrafuzz-sync-rotated-credential";
  const oldCredential = "old provider credential that must stay concealed";
  const rotatedCredential = "new provider credential after rotation";
  const failureEvents = (message: string): string =>
    workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId: "node:project-discovery", attempt: 1 },
      { type: "NodeFailed", nodeId: "node:project-discovery", attempt: 1, error: { message } }
    ]);
  const lifecycleEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: "node:project-discovery", state: "failed", attempt: 1 }]
    }),
    events: failureEvents(`provider echoed ${oldCredential}`)
  });
  const initialEnv = { ...lifecycleEnv, OPENAI_API_KEY: oldCredential };
  const run = await startRun({ projectRoot: project, runId, env: initialEnv });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const statePath = path.join(run.value!.run_root, "state.json");
  const ledgerPath = path.join(run.value!.run_root, "attempts.jsonl");
  const createdAt = (JSON.parse(fs.readFileSync(statePath, "utf8")) as { created_at: string }).created_at;
  const synchronize = (env: NodeJS.ProcessEnv) =>
    syncRun({ projectRoot: project, runId, env }, { now: () => Date.parse(createdAt) + 1_000 });

  const first = await synchronize(initialEnv);
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.ok(!first.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  const stateBeforeRotation = fs.readFileSync(statePath);
  const ledgerBeforeRotation = fs.readFileSync(ledgerPath);
  for (const evidence of [stateBeforeRotation, ledgerBeforeRotation]) {
    assert.match(evidence.toString("utf8"), /provider echoed <redacted>/u);
    assert.doesNotMatch(evidence.toString("utf8"), new RegExp(oldCredential, "u"));
  }

  const rotatedEnv = { ...initialEnv, OPENAI_API_KEY: rotatedCredential };
  const replayed = await synchronize(rotatedEnv);
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.ok(!replayed.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  const snapshots = [
    [statePath, stateBeforeRotation],
    [ledgerPath, ledgerBeforeRotation]
  ] as const;
  for (const [file, before] of snapshots) {
    assert.deepEqual(fs.readFileSync(file), before);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), new RegExp(`${oldCredential}|${rotatedCredential}`, "u"));
  }

  fs.writeFileSync(lifecycleEnv.SMITHERS_FAKE_EVENTS!, failureEvents(`different provider failure ${oldCredential}`));
  const changed = await synchronize(rotatedEnv);
  assert.equal(changed.ok, true, JSON.stringify(changed.diagnostics));
  assert.ok(changed.diagnostics.some((diagnostic) => diagnostic.code === "NODE_ATTEMPT_LEDGER_WRITE_FAILED"));
  for (const [file, before] of snapshots) assert.deepEqual(fs.readFileSync(file), before);
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
      .replace(
        "[agents.CodexAgent]",
        '[retry]\nsame_agent_attempts = 3\nagents = ["sol-xhigh", "gpt55-xhigh"]\n\n[agents.CodexAgent]'
      )
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
      .replace(
        "[agents.CodexAgent]",
        '[retry]\nsame_agent_attempts = 1\nagents = ["shared-a", "shared-b", "shared-c"]\n\n[agents.CodexAgent]'
      )
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

test("syncRun preserves a recorded terminal occurrence when Smithers reuses its attempt number", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-reused-attempt-number";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nodeId = "node:project-discovery";
  const events = [
    { type: "NodeStarted", nodeId, attempt: 1 },
    { type: "NodeFailed", nodeId, attempt: 1, error: { message: "first occurrence failed" } }
  ];
  const failedEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: nodeId, state: "failed", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, events)
  });
  const run = await startRun({ projectRoot: project, runId, env: failedEnv });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const firstSync = await syncRun({ projectRoot: project, runId, env: failedEnv });
  assert.equal(firstSync.ok, true, JSON.stringify(firstSync.diagnostics));

  const attemptDetail = (state: "in-progress" | "failed") => ({
    node: { nodeId, lastAttempt: 1 },
    attempts: [
      {
        nodeId,
        attempt: 1,
        state,
        meta: {
          agentChainIndex: 0,
          agentId: "ultrafuzz-agent:project-discovery:0:default",
          agentModel: "gpt-5.5"
        }
      }
    ]
  });
  const activeEvents = [...events, { type: "NodeStarted", nodeId, attempt: 1 }];
  const activeEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: nodeId, state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, activeEvents),
    nodeDetails: { [nodeId]: attemptDetail("in-progress") }
  });
  const interruptedSync = await syncRun({ projectRoot: project, runId, env: activeEnv });
  assert.equal(interruptedSync.ok, true, JSON.stringify(interruptedSync.diagnostics));
  assert.equal(interruptedSync.value?.status, "running");
  const ledgerPath = path.join(run.value!.run_root, "attempts.jsonl");
  const recordedBeforeCurrentTerminal = fs.readFileSync(ledgerPath, "utf8");

  const currentEnv = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [{ id: nodeId, state: "failed", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      ...activeEvents,
      { type: "NodeFailed", nodeId, attempt: 1, error: { message: "current occurrence failed" } }
    ]),
    nodeDetails: { [nodeId]: attemptDetail("failed") }
  });
  const currentSync = await syncRun({ projectRoot: project, runId, env: currentEnv });
  assert.equal(currentSync.ok, true, JSON.stringify(currentSync.diagnostics));
  const attempts = fs
    .readFileSync(ledgerPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { started_event_sequence: number; source_event_sequence: number });
  assert.equal(recordedBeforeCurrentTerminal.trim().split("\n").length, 1);
  assert.deepEqual(
    attempts.map((attempt) => [attempt.started_event_sequence, attempt.source_event_sequence]),
    [
      [0, 1],
      [2, 3]
    ]
  );
});

test("syncRun accepts a superseded unadmitted success with exact sealed trace authority", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-traced-reused-attempt";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nodeId = "node:project-discovery";
  const base = Date.parse("2026-07-03T00:00:00.000Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: nodeId, state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId, attempt: 1 },
      {
        type: "AgentTraceSummary",
        nodeId,
        extra: {
          iteration: 0,
          attempt: 1,
          summary: {
            runId: workflowRunId,
            nodeId,
            iteration: 0,
            attempt: 1,
            traceStartedAtMs: base + 50,
            traceFinishedAtMs: base + 100,
            agentId: "ultrafuzz-agent:project-discovery:0:default",
            model: "gpt-5.5"
          }
        }
      },
      { type: "NodeFinished", nodeId, attempt: 1 },
      { type: "RunStarted" },
      { type: "NodeStarted", nodeId, attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId, env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8"), "");
  assert.equal(
    fs.existsSync(path.join(run.value!.run_root, "artifacts", "project-discovery", "artifact-manifest.json")),
    false
  );
});

test("syncRun accepts exact historical trace authority after an immutable output-validation failure", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-traced-retry-after-output-failure";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nodeId = "node:project-discovery";
  const base = Date.parse("2026-07-03T00:00:00.000Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      steps: [
        { id: nodeId, state: "finished", attempt: 1 },
        { id: "verify:project-discovery", state: "failed", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "RunStarted" },
      { type: "NodeStarted", nodeId, attempt: 1 },
      {
        type: "AgentTraceSummary",
        nodeId,
        extra: {
          iteration: 0,
          attempt: 1,
          summary: {
            runId: workflowRunId,
            nodeId,
            iteration: 0,
            attempt: 1,
            traceStartedAtMs: base + 150,
            traceFinishedAtMs: base + 200,
            agentId: "ultrafuzz-agent:project-discovery:0:default",
            model: "gpt-5.5"
          }
        }
      },
      { type: "NodeFinished", nodeId, attempt: 1 },
      { type: "RunStarted" },
      { type: "NodeStarted", nodeId, attempt: 1 },
      {
        type: "AgentTraceSummary",
        nodeId,
        extra: {
          iteration: 0,
          attempt: 1,
          summary: {
            runId: workflowRunId,
            nodeId,
            iteration: 0,
            attempt: 1,
            traceStartedAtMs: base + 550,
            traceFinishedAtMs: base + 600,
            agentId: "ultrafuzz-agent:project-discovery:0:default",
            model: "gpt-5.5"
          }
        }
      },
      { type: "NodeFinished", nodeId, attempt: 1 },
      { type: "NodeStarted", nodeId: "verify:project-discovery", attempt: 1 },
      {
        type: "NodeFailed",
        nodeId: "verify:project-discovery",
        attempt: 1,
        error: { message: "artifact-contract failure: required output is missing" }
      },
      { type: "RunFailed" }
    ]),
    nodeDetails: {
      [nodeId]: {
        node: { nodeId, lastAttempt: 1 },
        attempts: [
          {
            nodeId,
            attempt: 1,
            state: "finished",
            meta: {
              agentChainIndex: 0,
              agentId: "ultrafuzz-agent:project-discovery:0:default",
              agentModel: "gpt-5.5"
            }
          }
        ]
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root, runId);
  const state = readRunState(layout);
  const prior = state.nodes["project-discovery"]!;
  state.status = "failed";
  state.nodes["project-discovery"] = {
    ...prior,
    status: "failed",
    timed_out: false,
    finished_at: new Date(base + 350).toISOString(),
    last_error: "artifact-contract failure: required output is missing",
    provenance: {
      ...prior.provenance,
      output_contracts: { ok: false, missing: ["findings.json"] },
      failure: {
        category: "artifact-contract",
        causal_task_id: "verify:project-discovery",
        causal_failure_category: "artifact-contract",
        dependent_task_ids: []
      },
      terminal_disposition: {
        schema_version: "ultrafuzz.terminal-disposition.v1",
        kind: "task-output-validation-failure"
      }
    }
  };
  writeRunState(layout, state);

  const sync = await syncRun({ projectRoot: project, runId, env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.ok(!sync.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_ATTEMPT_INSPECT_FAILED"));
  assert.equal(fs.existsSync(path.join(layout.artifactsDir, "project-discovery", "artifact-manifest.json")), false);
  assert.match(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /^node node:project-discovery /mu);
});

test("syncRun preserves a published replacement verified under a later activation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
  const runId = "sync-published-traced-replacement";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nodeId = "node:project-discovery";
  const verifierNodeId = "verify:project-discovery";
  const base = Date.parse("2026-07-03T00:00:00.000Z");
  const replacementEvents: Parameters<typeof workflowEvents>[1] = [
    { type: "RunStarted", sequence: 4, timestampMs: base + 400 },
    { type: "NodeStarted", nodeId, attempt: 1, sequence: 5, timestampMs: base + 500 },
    {
      type: "AgentTraceSummary",
      nodeId,
      sequence: 6,
      timestampMs: base + 600,
      extra: {
        iteration: 0,
        attempt: 1,
        summary: {
          runId: workflowRunId,
          nodeId,
          iteration: 0,
          attempt: 1,
          traceStartedAtMs: base + 550,
          traceFinishedAtMs: base + 600,
          agentId: "ultrafuzz-agent:project-discovery:0:default",
          model: "gpt-5.5"
        }
      }
    },
    { type: "NodeFinished", nodeId, attempt: 1, sequence: 7, timestampMs: base + 700 },
    { type: "RunStarted", sequence: 8, timestampMs: base + 800 },
    { type: "NodeStarted", nodeId: verifierNodeId, attempt: 1, sequence: 9, timestampMs: base + 900 },
    { type: "NodeFinished", nodeId: verifierNodeId, attempt: 1, sequence: 10, timestampMs: base + 1_000 },
    { type: "RunFinished", sequence: 11, timestampMs: base + 1_100 }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [{ id: nodeId, state: "finished", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, replacementEvents)
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH, "findings.json"]);
  const published = await syncRun({ projectRoot: project, runId, env });
  assert.equal(published.ok, true, JSON.stringify(published.diagnostics));
  assert.equal(published.value?.status, "succeeded", JSON.stringify(published.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root, runId);
  const manifestPath = path.join(layout.artifactsDir, "project-discovery", "artifact-manifest.json");
  const manifestBeforeReplay = fs.readFileSync(manifestPath);
  const taskStateBeforeReplay = structuredClone(readRunState(layout).nodes["project-discovery"]);
  const ledgerBeforeReplay = fs.readFileSync(layout.attemptLedgerPath);

  const historicalEvents: Parameters<typeof workflowEvents>[1] = [
    { type: "RunStarted", sequence: 0, timestampMs: base },
    { type: "NodeStarted", nodeId, attempt: 1, sequence: 1, timestampMs: base + 100 },
    {
      type: "AgentTraceSummary",
      nodeId,
      sequence: 2,
      timestampMs: base + 200,
      extra: {
        iteration: 0,
        attempt: 1,
        summary: {
          runId: workflowRunId,
          nodeId,
          iteration: 0,
          attempt: 1,
          traceStartedAtMs: base + 150,
          traceFinishedAtMs: base + 200,
          agentId: "ultrafuzz-agent:project-discovery:0:default",
          model: "gpt-5.5"
        }
      }
    },
    { type: "NodeFinished", nodeId, attempt: 1, sequence: 3, timestampMs: base + 300 },
    ...replacementEvents
  ];
  fs.writeFileSync(env.SMITHERS_FAKE_EVENTS!, workflowEvents(workflowRunId, historicalEvents), "utf8");

  const replayed = await syncRun({ projectRoot: project, runId, env });

  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.equal(replayed.value?.status, "succeeded");
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBeforeReplay);
  assert.deepEqual(readRunState(layout).nodes["project-discovery"], taskStateBeforeReplay);
  assert.deepEqual(fs.readFileSync(layout.attemptLedgerPath), ledgerBeforeReplay);
  const attempts = ledgerBeforeReplay
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { source_event_sequence?: number });
  assert.deepEqual(
    attempts.map((attempt) => attempt.source_event_sequence),
    [7]
  );

  const restartedEvents = historicalEvents.map((event) =>
    event.sequence !== undefined && event.sequence >= 8 ? { ...event, sequence: event.sequence + 1 } : event
  );
  const verifierActivationIndex = restartedEvents.findIndex(
    (event) => event.type === "RunStarted" && event.timestampMs === base + 800
  );
  assert.notEqual(verifierActivationIndex, -1);
  restartedEvents.splice(verifierActivationIndex, 0, {
    type: "NodeStarted",
    nodeId,
    attempt: 1,
    sequence: 8,
    timestampMs: base + 750
  });
  fs.writeFileSync(env.SMITHERS_FAKE_EVENTS!, workflowEvents(workflowRunId, restartedEvents), "utf8");

  const rejected = await syncRun({ projectRoot: project, runId, env });

  assert.equal(rejected.ok, false);
  assert.deepEqual(
    rejected.diagnostics.map((diagnostic) => diagnostic.code),
    ["WORKFLOW_ATTEMPT_INSPECT_FAILED"]
  );
  assert.match(rejected.diagnostics[0]?.message ?? "", /before durable attempt recording/u);
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBeforeReplay);
  assert.deepEqual(readRunState(layout).nodes["project-discovery"], taskStateBeforeReplay);
  assert.deepEqual(fs.readFileSync(layout.attemptLedgerPath), ledgerBeforeReplay);
});

test("syncRun binds an abandoned reused attempt to the final published higher retry", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
  const runId = "sync-published-after-abandoned-reuse";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nodeId = "node:project-discovery";
  const verifierNodeId = "verify:project-discovery";
  const base = Date.parse("2026-07-03T00:00:00.000Z");
  const publishedEvents: Parameters<typeof workflowEvents>[1] = [
    { type: "RunStarted", sequence: 6, timestampMs: base + 600 },
    { type: "NodeStarted", nodeId, attempt: 3, sequence: 7, timestampMs: base + 700 },
    {
      type: "AgentTraceSummary",
      nodeId,
      sequence: 8,
      timestampMs: base + 800,
      extra: {
        iteration: 0,
        attempt: 3,
        summary: {
          runId: workflowRunId,
          nodeId,
          iteration: 0,
          attempt: 3,
          traceStartedAtMs: base + 750,
          traceFinishedAtMs: base + 800,
          agentId: "ultrafuzz-agent:project-discovery:0:default",
          model: "gpt-5.5"
        }
      }
    },
    { type: "NodeFinished", nodeId, attempt: 3, sequence: 9, timestampMs: base + 900 },
    { type: "NodeStarted", nodeId: verifierNodeId, attempt: 1, sequence: 10, timestampMs: base + 1_000 },
    { type: "NodeFinished", nodeId: verifierNodeId, attempt: 1, sequence: 11, timestampMs: base + 1_100 },
    { type: "RunFinished", sequence: 12, timestampMs: base + 1_200 }
  ];
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      steps: [
        { id: nodeId, state: "finished", attempt: 3 },
        { id: verifierNodeId, state: "finished", attempt: 1 }
      ]
    }),
    events: workflowEvents(workflowRunId, publishedEvents)
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  writeRequiredArtifactSet(run.value!.run_root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH, "findings.json"]);
  const published = await syncRun({ projectRoot: project, runId, env });
  assert.equal(published.ok, true, JSON.stringify(published.diagnostics));
  assert.equal(published.value?.status, "succeeded", JSON.stringify(published.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root, runId);
  const manifestPath = path.join(layout.artifactsDir, "project-discovery", "artifact-manifest.json");
  const manifestBeforeReplay = fs.readFileSync(manifestPath);
  const taskStateBeforeReplay = structuredClone(readRunState(layout).nodes["project-discovery"]);
  const ledgerBeforeReplay = fs.readFileSync(layout.attemptLedgerPath);

  const historicalEvents: Parameters<typeof workflowEvents>[1] = [
    { type: "RunStarted", sequence: 0, timestampMs: base },
    { type: "NodeStarted", nodeId, attempt: 2, sequence: 1, timestampMs: base + 100 },
    {
      type: "AgentTraceSummary",
      nodeId,
      sequence: 2,
      timestampMs: base + 200,
      extra: {
        iteration: 0,
        attempt: 2,
        summary: {
          runId: workflowRunId,
          nodeId,
          iteration: 0,
          attempt: 2,
          traceStartedAtMs: base + 150,
          traceFinishedAtMs: base + 200,
          agentId: "ultrafuzz-agent:project-discovery:0:default",
          model: "gpt-5.5"
        }
      }
    },
    { type: "NodeFinished", nodeId, attempt: 2, sequence: 3, timestampMs: base + 300 },
    { type: "RunStarted", sequence: 4, timestampMs: base + 400 },
    { type: "NodeStarted", nodeId, attempt: 2, sequence: 5, timestampMs: base + 500 },
    ...publishedEvents
  ];
  fs.writeFileSync(env.SMITHERS_FAKE_EVENTS!, workflowEvents(workflowRunId, historicalEvents), "utf8");

  const replayed = await syncRun({ projectRoot: project, runId, env });

  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.equal(replayed.value?.status, "succeeded");
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBeforeReplay);
  assert.deepEqual(readRunState(layout).nodes["project-discovery"], taskStateBeforeReplay);
  assert.deepEqual(fs.readFileSync(layout.attemptLedgerPath), ledgerBeforeReplay);

  const expectRejected = async (events: Parameters<typeof workflowEvents>[1]): Promise<void> => {
    fs.writeFileSync(env.SMITHERS_FAKE_EVENTS!, workflowEvents(workflowRunId, events), "utf8");
    const rejected = await syncRun({ projectRoot: project, runId, env });
    assert.equal(rejected.ok, false);
    assert.deepEqual(
      rejected.diagnostics.map((diagnostic) => diagnostic.code),
      ["WORKFLOW_ATTEMPT_INSPECT_FAILED"]
    );
    assert.match(rejected.diagnostics[0]?.message ?? "", /before durable attempt recording/u);
    assert.deepEqual(fs.readFileSync(manifestPath), manifestBeforeReplay);
    assert.deepEqual(readRunState(layout).nodes["project-discovery"], taskStateBeforeReplay);
    assert.deepEqual(fs.readFileSync(layout.attemptLedgerPath), ledgerBeforeReplay);
  };

  await expectRejected(historicalEvents.filter((event) => event.sequence !== 6));

  const terminalBeforeBoundary = historicalEvents.map((event) =>
    event.sequence !== undefined && event.sequence >= 6 ? { ...event, sequence: event.sequence + 1 } : event
  );
  terminalBeforeBoundary.push({
    type: "NodeFailed",
    nodeId,
    attempt: 2,
    sequence: 6,
    timestampMs: base + 550,
    error: { message: "intervening occurrence terminated" }
  });
  terminalBeforeBoundary.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  await expectRejected(terminalBeforeBoundary);

  const ambiguousReplacementTrace = historicalEvents.map((event) =>
    event.sequence !== undefined && event.sequence >= 9 ? { ...event, sequence: event.sequence + 1 } : event
  );
  ambiguousReplacementTrace.push({
    type: "AgentTraceSummary",
    nodeId,
    sequence: 9,
    timestampMs: base + 850,
    extra: {
      iteration: 0,
      attempt: 3,
      summary: {
        runId: workflowRunId,
        nodeId,
        iteration: 0,
        attempt: 3,
        traceStartedAtMs: base + 825,
        traceFinishedAtMs: base + 850,
        agentId: "ultrafuzz-agent:project-discovery:0:default",
        model: "gpt-5.5"
      }
    }
  });
  ambiguousReplacementTrace.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  await expectRejected(ambiguousReplacementTrace);
});

test("syncRun rejects trace-only supersession of an immutable successful publication", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-traced-reuse-after-publication";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nodeId = "node:project-discovery";
  const base = Date.parse("2026-07-03T00:00:00.000Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: nodeId, state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "RunStarted" },
      { type: "NodeStarted", nodeId, attempt: 1 },
      {
        type: "AgentTraceSummary",
        nodeId,
        extra: {
          iteration: 0,
          attempt: 1,
          summary: {
            runId: workflowRunId,
            nodeId,
            iteration: 0,
            attempt: 1,
            traceStartedAtMs: base + 150,
            traceFinishedAtMs: base + 200,
            agentId: "ultrafuzz-agent:project-discovery:0:default",
            model: "gpt-5.5"
          }
        }
      },
      { type: "NodeFinished", nodeId, attempt: 1 },
      { type: "RunStarted" },
      { type: "NodeStarted", nodeId, attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const layout = layoutForRunRoot(run.value!.run_root, runId);
  const state = readRunState(layout);
  state.nodes["project-discovery"] = {
    ...state.nodes["project-discovery"]!,
    status: "succeeded",
    timed_out: false,
    finished_at: new Date(base + 300).toISOString()
  };
  writeRunState(layout, state);

  const sync = await syncRun({ projectRoot: project, runId, env });

  assert.equal(sync.ok, false);
  assert.deepEqual(
    sync.diagnostics.map((diagnostic) => diagnostic.code),
    ["WORKFLOW_ATTEMPT_INSPECT_FAILED"]
  );
  assert.match(sync.diagnostics[0]?.message ?? "", /before durable attempt recording/u);
});

test("syncRun rejects exact trace authority when an attempt identity is reused within one activation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-same-activation-traced-attempt";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nodeId = "node:project-discovery";
  const base = Date.parse("2026-07-03T00:00:00.000Z");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: nodeId, state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "RunStarted" },
      { type: "NodeStarted", nodeId, attempt: 1 },
      {
        type: "AgentTraceSummary",
        nodeId,
        extra: {
          iteration: 0,
          attempt: 1,
          summary: {
            runId: workflowRunId,
            nodeId,
            iteration: 0,
            attempt: 1,
            traceStartedAtMs: base + 150,
            traceFinishedAtMs: base + 200,
            agentId: "ultrafuzz-agent:project-discovery:0:default",
            model: "gpt-5.5"
          }
        }
      },
      { type: "NodeFinished", nodeId, attempt: 1 },
      { type: "NodeStarted", nodeId, attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId, env });

  assert.equal(sync.ok, false);
  assert.deepEqual(
    sync.diagnostics.map((diagnostic) => diagnostic.code),
    ["WORKFLOW_ATTEMPT_INSPECT_FAILED"]
  );
  assert.match(sync.diagnostics[0]?.message ?? "", /before durable attempt recording/u);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8"), "");
});

test("syncRun replays bounded production lifecycle history with ledgered and trace-authorized supersessions", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-production-supersession-history";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nodeId = "node:project-discovery";
  const base = Date.parse("2026-07-03T00:00:00.000Z");
  const history: Parameters<typeof workflowEvents>[1] = [{ type: "RunStarted" }, { type: "NodeStarted", nodeId }];
  const occurrences: Array<{
    index: number;
    startedSequence: number;
    finishedSequence: number;
    outcome: "failed" | "succeeded";
  }> = [];
  let startedSequence = 1;
  for (let index = 0; index < 104; index += 1) {
    const summarySequence = history.length;
    history.push({
      type: "AgentTraceSummary",
      nodeId,
      extra: {
        iteration: 0,
        attempt: 1,
        summary: {
          runId: workflowRunId,
          nodeId,
          iteration: 0,
          attempt: 1,
          traceStartedAtMs: base + startedSequence * 100 + 10,
          traceFinishedAtMs: base + summarySequence * 100,
          agentId: "ultrafuzz-agent:project-discovery:0:default",
          model: "gpt-5.5"
        }
      }
    });
    // A high-volume agent event category remains excluded by the patched
    // lifecycle query; only the compact immutable summary is admitted.
    history.push({ type: "AgentTraceEvent", nodeId, extra: { message: `noise-${index}` } });
    const outcome = index < 60 ? "failed" : "succeeded";
    const finishedSequence = history.length;
    history.push(
      outcome === "failed"
        ? { type: "NodeFailed", nodeId, error: { message: `historical failure ${index}` } }
        : { type: "NodeFinished", nodeId }
    );
    occurrences.push({ index, startedSequence, finishedSequence, outcome });
    history.push({ type: "RunStarted" }, { type: "NodeStarted", nodeId });
    startedSequence = history.length - 1;
  }
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: nodeId, state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, history),
    emulatePatchedLifecycleFilter: true
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const layout = layoutForRunRoot(run.value!.run_root, runId);
  appendNodeAttempts(
    layout,
    occurrences.slice(0, 79).map((occurrence) => ({
      workflowRunId,
      controlGeneration: evidence.controlGeneration,
      nodeId: "project-discovery",
      strategyAttemptId: "project-discovery",
      iteration: 0,
      attempt: 1,
      startedEventSequence: occurrence.startedSequence,
      sourceEventSequence: occurrence.finishedSequence,
      startedAt: new Date(base + occurrence.startedSequence * 100).toISOString(),
      finishedAt: new Date(base + occurrence.finishedSequence * 100).toISOString(),
      outcome: occurrence.outcome,
      inputManifestDigest: manifestDigest("historical-input"),
      ...(occurrence.outcome === "succeeded"
        ? { outputManifestDigest: manifestDigest(`historical-output-${occurrence.index}`) }
        : {
            failureCategory: "executor-error" as const,
            failureMessage: `historical failure ${occurrence.index}`
          }),
      agent: {
        chain_index: 0,
        profile_id: "default",
        agent_ref: "codex",
        model_name: "gpt-5.5",
        role: "primary" as const,
        selection: "observed" as const
      }
    }))
  );

  const sync = await syncRun({ projectRoot: project, runId, env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
  assert.equal(fs.readFileSync(layout.attemptLedgerPath, "utf8").trim().split("\n").length, 79);
  const lifecycleOutput = fs.readFileSync(env.SMITHERS_FAKE_EVENTS!, "utf8");
  assert.equal(
    lifecycleOutput
      .trim()
      .split("\n")
      .filter((line) => (JSON.parse(line) as { type?: unknown }).type === "AgentTraceSummary").length,
    104
  );
  assert.doesNotMatch(lifecycleOutput, /"type":"AgentTraceEvent"/u);
  const commandLog = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commandLog, /events .* --limit 100000 --json/u);
  assert.doesNotMatch(commandLog, /--raw|--type agent/u);
});

test("syncRun rejects a superseded unadmitted success without exact trace authority", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-untraced-reused-attempt";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nodeId = "node:project-discovery";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: nodeId, state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId, attempt: 1 },
      { type: "NodeFinished", nodeId, attempt: 1 },
      { type: "NodeStarted", nodeId, attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId, env });

  assert.equal(sync.ok, false);
  assert.deepEqual(
    sync.diagnostics.map((diagnostic) => diagnostic.code),
    ["WORKFLOW_ATTEMPT_INSPECT_FAILED"]
  );
  assert.match(sync.diagnostics[0]?.message ?? "", /before durable attempt recording/u);
});

test("syncRun rejects an unrecorded terminal occurrence superseded by a reused attempt number", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-unrecorded-reused-attempt";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nodeId = "node:project-discovery";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: nodeId, state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId, attempt: 1 },
      { type: "NodeFailed", nodeId, attempt: 1, error: { message: "unrecorded occurrence" } },
      { type: "NodeStarted", nodeId, attempt: 1 }
    ]),
    nodeDetails: {
      [nodeId]: {
        node: { nodeId, lastAttempt: 1 },
        attempts: [{ nodeId, attempt: 1, state: "in-progress" }]
      }
    }
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId, env });

  assert.equal(sync.ok, false);
  assert.deepEqual(
    sync.diagnostics.map((diagnostic) => diagnostic.code),
    ["WORKFLOW_ATTEMPT_INSPECT_FAILED"]
  );
  assert.match(sync.diagnostics[0]?.message ?? "", /supersedes terminal event 1 before durable attempt recording/u);
  assert.equal(fs.readFileSync(path.join(run.value!.run_root, "attempts.jsonl"), "utf8"), "");
});

test("syncRun rejects duplicate active starts for one reused attempt identity", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-duplicate-active-attempt";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nodeId = "node:project-discovery";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: nodeId, state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "NodeStarted", nodeId, attempt: 1 },
      { type: "NodeStarted", nodeId, attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId, env });

  assert.equal(sync.ok, false);
  assert.deepEqual(
    sync.diagnostics.map((diagnostic) => diagnostic.code),
    ["WORKFLOW_ATTEMPT_INSPECT_FAILED"]
  );
  assert.match(sync.diagnostics[0]?.message ?? "", /multiple active NodeStarted events/u);
});

test("syncRun abandons an unterminated occurrence at a later run activation boundary", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "sync-restarted-active-attempt";
  const workflowRunId = `ultrafuzz-${runId}`;
  const nodeId = "node:project-discovery";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "running",
      state: "running",
      steps: [{ id: nodeId, state: "in-progress", attempt: 1 }]
    }),
    events: workflowEvents(workflowRunId, [
      { type: "RunStarted" },
      { type: "NodeStarted", nodeId, attempt: 1 },
      { type: "RunStarted" },
      { type: "NodeStarted", nodeId, attempt: 1 }
    ])
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));

  const sync = await syncRun({ projectRoot: project, runId, env });

  assert.equal(sync.ok, true, JSON.stringify(sync.diagnostics));
  assert.equal(sync.value?.status, "running");
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

test("controller refresh selects current source without rewriting historical evidence", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-success";
  const env = controllerRefreshTerminalEnv(project, runId, { enforceWorkflowChangeAcceptance: true });
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));

  const metadataPath = path.join(launched.value!.run_root, "run.json");
  const statePath = path.join(launched.value!.run_root, "state.json");
  const journalPath = path.join(launched.value!.run_root, "smithers", "workflow-run-link-journal.json");
  const resolvedConfigPath = path.join(launched.value!.run_root, "smithers", "resolved-config.json");
  const tasksPath = path.join(launched.value!.run_root, "smithers", "tasks.json");
  const smithersGraphPath = path.join(launched.value!.run_root, "smithers", "expanded-graph.json");
  const canonicalGraphPath = path.join(launched.value!.run_root, "graph.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    workflow?: { path?: string; run_id?: string };
  };
  assert.ok(metadata.workflow?.path);
  const historicalWorkflowPath = path.join(project, metadata.workflow.path);
  const historicalWorkflow = fs.readFileSync(historicalWorkflowPath);
  const historicalConfig = JSON.parse(fs.readFileSync(resolvedConfigPath, "utf8")) as {
    run: Record<string, unknown>;
  };
  historicalConfig.run.maxParallelNodes = 8;
  fs.writeFileSync(resolvedConfigPath, `${JSON.stringify(historicalConfig, null, 2)}\n`, "utf8");
  const tasks = JSON.parse(fs.readFileSync(tasksPath, "utf8")) as SmithersTaskManifestDocument;
  const referencedAttempts = new Set(
    tasks.tasks.flatMap((task) => task.dependencyArtifactDirs.map((directory) => path.basename(directory)))
  );
  const leafTask = tasks.tasks.find((task) => !referencedAttempts.has(task.attemptId));
  assert.ok(leafTask);
  leafTask.metadata.node.group = "continuation-leaf";
  fs.writeFileSync(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
  const canonicalGraph = JSON.parse(fs.readFileSync(canonicalGraphPath, "utf8")) as {
    groups: Record<string, unknown>;
  };
  canonicalGraph.groups["continuation-leaf"] = { defaults: { failure_policy: "continue" } };
  fs.writeFileSync(canonicalGraphPath, `${JSON.stringify(canonicalGraph, null, 2)}\n`, "utf8");
  fs.rmSync(smithersGraphPath);
  const retainedConfig = fs.readFileSync(resolvedConfigPath);
  const retainedMetadata = fs.readFileSync(metadataPath);
  const retainedJournal = fs.readFileSync(journalPath);
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const refreshed = await resumeRun({ projectRoot: project, runId, refreshController: true, env });

  assert.equal(refreshed.ok, true, JSON.stringify(refreshed.diagnostics));
  assert.equal(refreshed.value?.run_id, runId);
  assert.equal(refreshed.value?.workflow_run_id, metadata.workflow.run_id);
  const command = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8").trim();
  const commands = command.split("\n");
  assert.equal(commands[0], `inspect ${metadata.workflow.run_id} --format json --full-output`);
  assert.match(
    commands[1] ?? "",
    /\.smithers\/continuations\/[0-9a-f-]+\/workflows\/ultrafuzz-controller-refresh-success\.tsx/u
  );
  assert.match(
    commands[1] ?? "",
    new RegExp(
      `--resume ${metadata.workflow.run_id} --run-id ${metadata.workflow.run_id} .*--accept-workflow-change`,
      "u"
    )
  );
  const continuationPath = /^up (\S+)/u.exec(commands[1] ?? "")?.[1];
  assert.ok(continuationPath);
  assert.equal(fs.existsSync(continuationPath), true);
  const continuationSource = fs.readFileSync(continuationPath, "utf8");
  const specsPrefix = "const serializedTaskSpecs = ";
  const specsStart = continuationSource.indexOf(specsPrefix);
  const specsEnd = continuationSource.indexOf(" as const;", specsStart);
  assert.ok(specsStart >= 0 && specsEnd > specsStart, continuationSource);
  const specs = JSON.parse(continuationSource.slice(specsStart + specsPrefix.length, specsEnd)) as Array<{
    attemptId: string;
    continueOnFail: boolean;
  }>;
  assert.equal(specs.find((task) => task.attemptId === leafTask.attemptId)?.continueOnFail, true);
  assert.deepEqual(fs.readFileSync(historicalWorkflowPath), historicalWorkflow);
  assert.deepEqual(fs.readFileSync(resolvedConfigPath), retainedConfig);
  assert.deepEqual(fs.readFileSync(metadataPath), retainedMetadata);
  assert.deepEqual(fs.readFileSync(journalPath), retainedJournal);
  const continuedState = JSON.parse(fs.readFileSync(statePath, "utf8")) as RunState;
  assert.equal(continuedState.status, "running");
  assert.equal(continuedState.finished_at, undefined);

  fs.rmSync(historicalWorkflowPath);
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  const refreshedWithoutHistoricalProjectWorkflow = await resumeRun({
    projectRoot: project,
    runId,
    refreshController: true,
    env
  });
  assert.equal(
    refreshedWithoutHistoricalProjectWorkflow.ok,
    true,
    JSON.stringify(refreshedWithoutHistoricalProjectWorkflow.diagnostics)
  );
});

test("a refresh resume reuses its own ownership inspection instead of inspecting twice", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-single-inspect";
  const smithersRunId = `ultrafuzz-${runId}`;
  const inspectCommand = `inspect ${smithersRunId} --format json --full-output`;
  const env = controllerRefreshTerminalEnv(project, runId);
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));
  const issuedCommands = (): string[] => fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8").trim().split("\n");

  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  const refreshed = await resumeRun({ projectRoot: project, runId, refreshController: true, env });

  assert.equal(refreshed.ok, true, JSON.stringify(refreshed.diagnostics));
  assert.equal(refreshed.value?.submitted, true);
  const refreshCommands = issuedCommands();
  // Refresh proves ownership before rendering, and the resume behind it reuses
  // that evidence. A second inspect would be a redundant subprocess per refresh
  // and would re-derive ownership from a run the renderer has already touched.
  assert.deepEqual(
    refreshCommands.filter((command) => command.startsWith("inspect ")),
    [inspectCommand]
  );
  assert.equal(refreshCommands[0], inspectCommand);
  assert.match(refreshCommands[1] ?? "", new RegExp(`^up .*--resume ${smithersRunId} --run-id ${smithersRunId} `, "u"));

  // The reused inspection is still the authority for explicit failed-task
  // recovery: a retrying refresh resets its failed node off one inspect.
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  const retried = await resumeRun({ projectRoot: project, runId, refreshController: true, retryFailed: true, env });
  assert.equal(retried.ok, true, JSON.stringify(retried.diagnostics));
  const retryCommands = issuedCommands();
  assert.deepEqual(
    retryCommands.filter((command) => command.startsWith("inspect ")),
    [inspectCommand]
  );
  assert.equal(
    retryCommands.some((command) => command.startsWith("timetravel ")),
    true,
    retryCommands.join("\n")
  );

  // An ordinary resume has no refresh inspection to inherit, so it performs its
  // own ownership check — exactly one, never zero and never two.
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  const ordinary = await resumeRun({ projectRoot: project, runId, env });
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary.diagnostics));
  assert.deepEqual(
    issuedCommands().filter((command) => command.startsWith("inspect ")),
    [inspectCommand]
  );
});

test("controller refresh sources stock adapters from the packaged closure instead of the project scaffold", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-packaged-adapters";
  const env = controllerRefreshTerminalEnv(project, runId);
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));

  const projectPiPath = path.join(project, ".smithers", "agents", "pi.ts");
  const unexpectedProjectAdapter = path.join(project, ".smithers", "agents", "unexpected.ts");
  const untrustedProjectBytes = "export const projectOwnedAdapter = true;\n";
  fs.writeFileSync(projectPiPath, untrustedProjectBytes, "utf8");
  fs.writeFileSync(unexpectedProjectAdapter, "export const unexpected = true;\n", "utf8");

  const refreshed = await resumeRun({ projectRoot: project, runId, refreshController: true, env });

  assert.equal(refreshed.ok, true, JSON.stringify(refreshed.diagnostics));
  const upCommand = fs
    .readFileSync(env.SMITHERS_FAKE_LOG!, "utf8")
    .trim()
    .split("\n")
    .filter((command) => command.startsWith("up "))
    .at(-1);
  const refreshedWorkflowPath = /^up (\S+)/u.exec(upCommand ?? "")?.[1];
  assert.ok(refreshedWorkflowPath);
  const refreshedRoot = path.dirname(path.dirname(refreshedWorkflowPath));
  assert.notEqual(fs.readFileSync(path.join(refreshedRoot, "agents", "pi.ts"), "utf8"), untrustedProjectBytes);
  assert.equal(fs.existsSync(path.join(refreshedRoot, "agents", "unexpected.ts")), false);
  assert.equal(fs.readFileSync(projectPiPath, "utf8"), untrustedProjectBytes);
  assert.equal(fs.existsSync(unexpectedProjectAdapter), true);
});

test("controller refresh sources internal modules from the invoking package closure", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-invoking-modules";
  const env = controllerRefreshTerminalEnv(project, runId);
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const resolvedConfig = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/resolved-config.json"
  );
  assert.ok(resolvedConfig);
  const config = parseResolvedConfigJsonBytes(resolvedConfig.contents);

  const invokingRuntimeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@ultrafuzz/runtime"))));
  const staleRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-stale-runtime-"));
  fs.copyFileSync(path.join(invokingRuntimeRoot, "package.json"), path.join(staleRuntimeRoot, "package.json"));
  for (const directory of ["dist", "schema"]) {
    const source = path.join(invokingRuntimeRoot, directory);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(staleRuntimeRoot, directory), { recursive: true });
  }
  const artifactGatesRelativePath = path.join("dist", "artifact-gates.js");
  const staleArtifactGatesPath = path.join(staleRuntimeRoot, artifactGatesRelativePath);
  fs.appendFileSync(staleArtifactGatesPath, "\n// stale compatible launch installation\n", "utf8");
  const staleArtifactGates = fs.readFileSync(staleArtifactGatesPath);
  const currentArtifactGates = fs.readFileSync(path.join(invokingRuntimeRoot, artifactGatesRelativePath));
  assert.notDeepEqual(staleArtifactGates, currentArtifactGates);

  const runtimeSnapshotPrefix = "modules/@ultrafuzz/runtime/";
  const launchFromStaleInstallation = {
    ...evidence.verifiedControl,
    executionFiles: evidence.verifiedControl.executionFiles.map((file) =>
      file.snapshotPath.startsWith(runtimeSnapshotPrefix)
        ? {
            ...file,
            sourcePath: path.join(staleRuntimeRoot, ...file.snapshotPath.slice(runtimeSnapshotPrefix.length).split("/"))
          }
        : file
    )
  };

  const refreshed = refreshedSmithersControllerSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    original: launchFromStaleInstallation,
    config
  });
  const refreshedArtifactGates = refreshed.snapshot.executionFiles.find(
    (file) => file.snapshotPath === `${runtimeSnapshotPrefix}dist/artifact-gates.js`
  );
  assert.ok(refreshedArtifactGates);
  assert.deepEqual(refreshedArtifactGates.contents, currentArtifactGates);
  assert.notDeepEqual(refreshedArtifactGates.contents, staleArtifactGates);
  assert.equal(
    path.dirname(path.dirname(refreshedArtifactGates.sourcePath)),
    invokingRuntimeRoot,
    "refreshed source provenance must identify the invoking package installation"
  );
});

test("controller refresh helper replaces missing or stale Bun startup controls", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-legacy-bun-controls";
  const env = controllerRefreshTerminalEnv(project, runId);
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));
  const before = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(before.ok, true, "diagnostics" in before ? JSON.stringify(before.diagnostics) : "");
  if (!before.ok) return;

  const startupControlPaths = ["controls/bun-module-confinement.js", "controls/bun-empty.env", "controls/bunfig.toml"];
  const currentControls = new Map(
    before.verifiedControl.executionFiles
      .filter((file) => startupControlPaths.includes(file.snapshotPath))
      .map((file) => [file.snapshotPath, file.contents] as const)
  );
  assert.equal(currentControls.size, startupControlPaths.length);
  const staleSource = path.join(before.layout.root, "smithers", "legacy-bun-module-confinement.js");
  fs.writeFileSync(staleSource, "legacy startup control\n", "utf8");
  const legacyFiles = [
    ...before.verifiedControl.executionFiles.filter((file) => !startupControlPaths.includes(file.snapshotPath)),
    {
      sourcePath: staleSource,
      snapshotPath: startupControlPaths[0]!,
      contents: Buffer.from("legacy startup control\n")
    }
  ];
  const replaced = replaceBunStartupControlsForControllerRefresh(before.layout, legacyFiles);
  const unchanged = legacyFiles.find((file) => !startupControlPaths.includes(file.snapshotPath));
  assert.ok(unchanged);
  const retained = replaced.find((file) => file.snapshotPath === unchanged.snapshotPath);
  assert.ok(retained);
  assert.notEqual(retained, unchanged, "refresh must clone the mutable file record");
  assert.equal(
    retained.contents,
    unchanged.contents,
    "refresh must share the immutable backing bytes for an unchanged execution file"
  );
  for (const startupPath of startupControlPaths) {
    const refreshed = replaced.filter((file) => file.snapshotPath === startupPath);
    assert.equal(refreshed.length, 1);
    assert.deepEqual(refreshed[0]!.contents, currentControls.get(startupPath));
    assert.notEqual(refreshed[0]!.sourcePath, staleSource);
  }
  assert.equal(fs.readFileSync(staleSource, "utf8"), "legacy startup control\n");
});

test("ordinary resume always delegates workflow-change admission to Smithers", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-authority-absent";
  const env = controllerRefreshTerminalEnv(project, runId);
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));

  const resumed = await resumeRun({ projectRoot: project, runId, env });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  const upCommands = fs
    .readFileSync(env.SMITHERS_FAKE_LOG!, "utf8")
    .trim()
    .split("\n")
    .filter((command) => command.startsWith("up "));
  assert.equal(upCommands.length, 2);
  assert.equal(upCommands.length, 2);
  assert.match(upCommands[1]!, /(?:^| )--accept-workflow-change(?: |$)/u);
});

test("fork child preflight receives sealed input and resolves it before creating the child", async () => {
  const project = tempProject();
  const env = fakeSmithersEnv(project);
  const commandLog = env.SMITHERS_FAKE_LOG!;
  const workflowPath = path.join(project, ".smithers", "workflows", "workflow.tsx");
  const relaunchInput = '{"required":"sealed-value"}';

  fs.writeFileSync(commandLog, "", "utf8");
  const forked = await runSmithersLifecycleCommand({
    action: "fork",
    smithersRunId: "ultrafuzz-fork-input-source",
    workflowPath,
    projectRoot: project,
    forkFrame: 7,
    relaunchPaths: {
      runRoot: project,
      inputJson: relaunchInput,
      logsDir: path.join(project, "logs")
    },
    keepWorkspaces: false,
    controllerLeaseSeconds: 60,
    env
  });
  assert.equal(forked.workflowRunId, "ultrafuzz-lifecycle-run-forked");
  assert.ok(forked.command.includes("<redacted>"));
  assert.equal(forked.command.includes(relaunchInput), false);
  assert.match(
    fs.readFileSync(commandLog, "utf8"),
    /up .* --resume ultrafuzz-lifecycle-run-forked --run-id ultrafuzz-lifecycle-run-forked --force --detach --input \{"required":"sealed-value"\} /u
  );

  fs.writeFileSync(commandLog, "", "utf8");
  await assert.rejects(
    runSmithersLifecycleCommand({
      action: "fork",
      smithersRunId: "ultrafuzz-fork-input-source",
      workflowPath,
      projectRoot: project,
      forkFrame: 7,
      keepWorkspaces: false,
      controllerLeaseSeconds: 60,
      env
    }),
    /sealed workflow relaunch input is unavailable/u
  );
  assert.equal(fs.readFileSync(commandLog, "utf8"), "", "missing sealed input must fail before fork creation");
});

test("controller refresh admits a new stock bootstrap module but rejects semantic drift", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-semantics";
  const env = controllerRefreshTerminalEnv(project, runId);
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const resolvedConfig = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/resolved-config.json"
  );
  assert.ok(resolvedConfig);
  const config = parseResolvedConfigJsonBytes(resolvedConfig.contents);
  const bootstrapPath = "modules/@ultrafuzz/runtime/dist/workflow-controller-generation.js";
  assert.equal(
    evidence.verifiedControl.executionFiles.some((file) => file.snapshotPath === bootstrapPath),
    true
  );
  const schemaPath = "modules/@ultrafuzz/artifacts/schema/event-record.schema.json";
  const sealedSchema = evidence.verifiedControl.executionFiles.find((file) => file.snapshotPath === schemaPath);
  assert.ok(sealedSchema);
  const historicalSchemaDocument = JSON.parse(sealedSchema.contents.toString("utf8")) as Record<string, unknown>;
  historicalSchemaDocument.$comment = "historical controller schema fixture";
  const historicalSchemaBytes = Buffer.from(`${JSON.stringify(historicalSchemaDocument, null, 2)}\n`, "utf8");
  const syntheticPreFix = {
    ...evidence.verifiedControl,
    executionFiles: evidence.verifiedControl.executionFiles
      .filter((file) => file.snapshotPath !== bootstrapPath)
      .map((file) => (file.snapshotPath === schemaPath ? { ...file, contents: historicalSchemaBytes } : file))
  };
  const rebuilt = refreshedSmithersControllerSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    original: syntheticPreFix,
    config
  });
  assert.equal(
    rebuilt.snapshot.executionFiles.some((file) => file.snapshotPath === bootstrapPath),
    true
  );
  assert.deepEqual(rebuilt.snapshot.contents.graph, evidence.verifiedControl.contents.graph);
  assert.deepEqual(rebuilt.snapshot.contents.tasks, evidence.verifiedControl.contents.tasks);
  assert.deepEqual(rebuilt.snapshot.contents.input, evidence.verifiedControl.contents.input);
  assert.deepEqual(
    rebuilt.snapshot.executionFiles.find((file) => file.snapshotPath === schemaPath)?.contents,
    historicalSchemaBytes,
    "controller refresh must preserve the sealed schema bundle"
  );

  const current = refreshedSmithersControllerSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    original: evidence.verifiedControl,
    config
  });
  assert.throws(
    () =>
      prepareControllerGeneration(
        evidence.layout,
        evidence.verifiedControl,
        { ...current, semanticFingerprint: "0".repeat(64) },
        { workflowRunId: evidence.smithersRunId, workflowLinkId: evidence.workflowLinkId }
      ),
    /changed sealed campaign semantics/u
  );
  assert.equal(fs.existsSync(path.join(evidence.layout.root, "smithers", "controller-generation-journal.json")), false);

  const prepared = prepareControllerGeneration(evidence.layout, evidence.verifiedControl, current, {
    workflowRunId: evidence.smithersRunId,
    workflowLinkId: evidence.workflowLinkId
  });
  const journalPath = path.join(evidence.layout.root, "smithers", "controller-generation-journal.json");
  const originalJournalBytes = fs.readFileSync(journalPath);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries?: Array<{
      phase?: string;
      manifest_path?: string;
      manifest_sha256?: string;
      previous_controller_generation?: string;
      sequence?: number;
    }>;
  };
  const pending = journal.entries?.at(-1);
  assert.equal(pending?.phase, "prepared");
  assert.ok(pending?.manifest_path);
  const manifestPath = path.join(evidence.layout.root, ...(pending.manifest_path ?? "").split("/"));
  const originalManifestBytes = fs.readFileSync(manifestPath);
  const malformedManifest = JSON.parse(originalManifestBytes.toString("utf8")) as Record<string, unknown>;
  malformedManifest.unexpected = true;
  const malformedManifestBytes = Buffer.from(`${JSON.stringify(malformedManifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(manifestPath, malformedManifestBytes);
  pending!.manifest_sha256 = crypto.createHash("sha256").update(malformedManifestBytes).digest("hex");
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  assert.throws(
    () => commitControllerGeneration(evidence.layout, evidence.verifiedControl, prepared.controllerGeneration),
    /controller generation manifest is invalid/u
  );
  fs.writeFileSync(manifestPath, originalManifestBytes);
  fs.writeFileSync(journalPath, originalJournalBytes);

  materializeWorkflowExecutionSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    snapshot: prepared.snapshot,
    authorizedGenerations: prepared.authorizedGenerations
  });
  const restoredJournal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries?: Array<{
      phase?: string;
      manifest_sha256?: string;
      previous_controller_generation?: string;
      sequence?: number;
    }>;
  };
  const restoredPending = restoredJournal.entries?.at(-1);
  appendEvent(evidence.layout, {
    eventType: "workflow-controller-generation-recorded",
    status: "running",
    payload: {
      workflow_run_id: evidence.smithersRunId,
      workflow_link_id: evidence.workflowLinkId,
      control_generation: evidence.controlGeneration,
      controller_generation: prepared.controllerGeneration,
      previous_controller_generation: restoredPending?.previous_controller_generation ?? evidence.controlGeneration,
      manifest_sha256: restoredPending?.manifest_sha256 ?? "0".repeat(64),
      semantic_fingerprint: "f".repeat(64),
      sequence: restoredPending?.sequence ?? 1
    }
  });
  assert.throws(
    () => commitControllerGeneration(evidence.layout, evidence.verifiedControl, prepared.controllerGeneration),
    /does not authenticate.*journal entry/u
  );
  const stillPrepared = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries?: Array<{ phase?: string }>;
  };
  assert.equal(stillPrepared.entries?.at(-1)?.phase, "prepared");
});

test("artifact gates validate a historical bundle through its active sealed schema snapshot", async () => {
  assert.equal(
    VALIDATOR_BUILD_IDENTITY,
    "ultrafuzz-json-validator.v1:028be3251e9ac213ad6e1c037d8da47c9d903e8be563c8f4fa2149839565bcab",
    "a compatibility-only bundle loader must retain the pre-upgrade validator identity"
  );
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, GENERIC_RUNTIME_MARKDOWN_PATH);
  const runId = "sealed-artifact-schema-bundle";
  const env = controllerRefreshTerminalEnv(project, runId);
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));
  const layout = layoutForRunRoot(launched.value!.run_root);
  writeRequiredArtifactSet(layout.root, "project-discovery", [GENERIC_RUNTIME_MARKDOWN_PATH, "findings.json"]);

  const state = readRunState(layout);
  const currentSnapshot =
    state.provenance?.workflow.controllerExecutionSnapshot ?? state.provenance?.workflow.executionSnapshot;
  assert.ok(currentSnapshot);
  const historicalSnapshot = `smithers/execution-snapshots/${"e".repeat(64)}`;
  const snapshotsRoot = path.join(layout.root, "smithers", "execution-snapshots");
  const historicalRoot = path.join(layout.root, ...historicalSnapshot.split("/"));
  fs.chmodSync(snapshotsRoot, 0o700);
  fs.cpSync(path.join(layout.root, ...currentSnapshot.split("/")), historicalRoot, { recursive: true });
  fs.chmodSync(snapshotsRoot, 0o500);
  const unrelatedSchemaPath = path.join(
    historicalRoot,
    "modules",
    "@ultrafuzz",
    "artifacts",
    "schema",
    "event-record.schema.json"
  );
  fs.chmodSync(unrelatedSchemaPath, 0o600);
  const unrelatedSchema = JSON.parse(fs.readFileSync(unrelatedSchemaPath, "utf8")) as Record<string, unknown>;
  unrelatedSchema.$comment = "historical runtime-only schema fixture";
  fs.writeFileSync(unrelatedSchemaPath, `${JSON.stringify(unrelatedSchema, null, 2)}\n`, "utf8");
  fs.chmodSync(unrelatedSchemaPath, 0o400);

  const artifactPath = path.join(layout.artifactsDir, "project-discovery", "findings.json");
  const schemaPath = path.join(historicalRoot, "modules", "@ultrafuzz", "artifacts", "schema", "findings.schema.json");
  const historicalValidation = validateRegisteredJsonBytesSync({
    schemaPath,
    instanceBytes: fs.readFileSync(artifactPath),
    schemaRegistry: artifactSchemaRegistryFromDirectory(path.dirname(schemaPath))
  });
  assert.equal(historicalValidation.status, "valid", JSON.stringify(historicalValidation.diagnostics));
  assert.ok(historicalValidation.schema);
  assert.notEqual(historicalValidation.schema.bundle_sha256, artifactSchemaBundleDigest());
  state.provenance!.workflow.controllerExecutionSnapshot = historicalSnapshot;
  writeRunState(layout, state);

  const graph = readPlannedGraphDocument(layout.graphPath);
  const node = structuredClone(graph.nodes.find((candidate) => candidate.id === "project-discovery")!);
  for (const output of node.outputs) {
    if (output.schema_bundle_sha256 !== undefined) {
      output.schema_bundle_sha256 = historicalValidation.schema.bundle_sha256;
    }
  }
  const verified = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(verified.ok, true, JSON.stringify(verified.diagnostics));

  state.provenance!.workflow.controllerExecutionSnapshot = `smithers/execution-snapshots/${"d".repeat(64)}`;
  writeRunState(layout, state);
  const missingAuthority = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingAuthority.ok, false);
  assert.ok(
    missingAuthority.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_SEALED_SCHEMA_AUTHORITY_INVALID")
  );
});

test("controller generation reloads authenticated dependency filenames outside artifact output grammar", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-portable-dependency-path";
  const env = controllerRefreshTerminalEnv(project, runId);
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const resolvedConfig = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/resolved-config.json"
  );
  assert.ok(resolvedConfig);
  const config = parseResolvedConfigJsonBytes(resolvedConfig.contents);
  const refreshed = refreshedSmithersControllerSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    original: evidence.verifiedControl,
    config
  });
  const retainedPath = "controls/plan.json";
  const originalRetained = evidence.verifiedControl.executionFiles.find((file) => file.snapshotPath === retainedPath);
  const refreshedRetained = refreshed.snapshot.executionFiles.find((file) => file.snapshotPath === retainedPath);
  assert.ok(originalRetained);
  assert.ok(refreshedRetained);
  assert.equal(
    refreshedRetained.contents,
    originalRetained.contents,
    "controller refresh must not copy unchanged execution bytes"
  );
  const declarationPath = "modules/synthetic-package/dist/$command.d.ts";
  const declarationContents = Buffer.from("export interface Command {}\n", "utf8");
  const refreshedWithDeclaration = {
    ...refreshed,
    snapshot: {
      ...refreshed.snapshot,
      executionFiles: [
        ...refreshed.snapshot.executionFiles,
        {
          sourcePath: path.join(project, "synthetic-package", "dist", "$command.d.ts"),
          snapshotPath: declarationPath,
          contents: declarationContents
        }
      ]
    }
  };
  const prepared = prepareControllerGeneration(evidence.layout, evidence.verifiedControl, refreshedWithDeclaration, {
    workflowRunId: evidence.smithersRunId,
    workflowLinkId: evidence.workflowLinkId
  });
  materializeWorkflowExecutionSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    snapshot: prepared.snapshot,
    authorizedGenerations: prepared.authorizedGenerations
  });

  const committed = commitControllerGeneration(
    evidence.layout,
    evidence.verifiedControl,
    prepared.controllerGeneration
  );

  const declaration = committed.snapshot.executionFiles.find((file) => file.snapshotPath === declarationPath);
  const committedRetained = committed.snapshot.executionFiles.find((file) => file.snapshotPath === retainedPath);
  assert.deepEqual(declaration?.contents, declarationContents);
  assert.notEqual(
    declaration?.contents,
    declarationContents,
    "new generation-only bytes must come from the authenticated published snapshot"
  );
  assert.equal(
    committedRetained?.contents,
    originalRetained.contents,
    "commit must reuse launch-generation bytes only after exact path, size, and digest authentication"
  );
  assert.equal(
    declaration?.sourcePath,
    path.join(
      evidence.layout.root,
      "smithers",
      "execution-snapshots",
      prepared.controllerGeneration,
      ...declarationPath.split("/")
    )
  );
  assert.equal(fs.lstatSync(declaration!.sourcePath).isFile(), true);
});

test("controller refresh resolves a synthetic sealed module from its authenticated package context", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-package-context";
  const env = controllerRefreshTerminalEnv(project, runId);
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const resolvedConfig = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/resolved-config.json"
  );
  const dependencyManifest = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "dependencies/manifest.json"
  );
  assert.ok(resolvedConfig);
  assert.ok(dependencyManifest);
  const config = parseResolvedConfigJsonBytes(resolvedConfig.contents);

  const moduleName = "@ultrafuzz/synthetic-controller-fixture";
  assert.throws(() => createRequire(import.meta.url).resolve(moduleName), { code: "MODULE_NOT_FOUND" });
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-controller-package-"));
  const packageJsonPath = path.join(packageRoot, "package.json");
  const modulePath = path.join(packageRoot, "dist", "index.js");
  const retiredModulePath = path.join(packageRoot, "dist", "retired-data.json");
  const packageJson = Buffer.from(`${JSON.stringify({ name: moduleName, version: "1.0.0" })}\n`, "utf8");
  const currentModule = Buffer.from("export const controllerFixture = 'current';\n", "utf8");
  const retiredModule = Buffer.from('{"retained":"sealed"}\n', "utf8");
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(packageJsonPath, packageJson);
  fs.writeFileSync(modulePath, currentModule);
  const manifestSnapshotPath = `modules/${moduleName}/package.json`;
  const moduleSnapshotPath = `modules/${moduleName}/dist/index.js`;
  const retiredModuleSnapshotPath = `modules/${moduleName}/dist/retired-data.json`;
  const moduleId = `module:${moduleName}`;
  const moduleRootSnapshotPath = `modules/${moduleName}`;
  const dependencyMap = JSON.parse(dependencyManifest.contents.toString("utf8")) as {
    modules: Array<{ id: string; name: string; snapshot_path: string }>;
    issuers: Array<{ id: string; snapshot_path: string; dependencies: Record<string, string> }>;
  };
  const refreshedDependencyMap = {
    ...dependencyMap,
    modules: [...dependencyMap.modules, { id: moduleId, name: moduleName, snapshot_path: moduleRootSnapshotPath }].sort(
      (left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    ),
    issuers: [...dependencyMap.issuers, { id: moduleId, snapshot_path: moduleRootSnapshotPath, dependencies: {} }].sort(
      (left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    )
  };
  const syntheticSnapshot = {
    ...evidence.verifiedControl,
    executionFiles: [
      ...evidence.verifiedControl.executionFiles.map((file) =>
        file.snapshotPath === dependencyManifest.snapshotPath
          ? { ...file, contents: Buffer.from(`${JSON.stringify(refreshedDependencyMap, null, 2)}\n`, "utf8") }
          : file.snapshotPath === "controls/bun-module-confinement.js"
            ? { ...file, contents: Buffer.from("legacy startup control\n", "utf8") }
            : file
      ),
      {
        sourcePath: packageJsonPath,
        snapshotPath: manifestSnapshotPath,
        contents: packageJson
      },
      {
        sourcePath: modulePath,
        snapshotPath: moduleSnapshotPath,
        contents: Buffer.from("export const controllerFixture = 'sealed';\n", "utf8")
      },
      {
        sourcePath: retiredModulePath,
        snapshotPath: retiredModuleSnapshotPath,
        contents: retiredModule
      }
    ]
  };

  const refreshed = refreshedSmithersControllerSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    original: syntheticSnapshot,
    config
  });

  assert.deepEqual(
    refreshed.snapshot.executionFiles.find((file) => file.snapshotPath === moduleSnapshotPath)?.contents,
    currentModule
  );
  assert.deepEqual(
    refreshed.snapshot.executionFiles.find((file) => file.snapshotPath === retiredModuleSnapshotPath)?.contents,
    retiredModule
  );
  assert.deepEqual(
    refreshed.snapshot.executionFiles.find((file) => file.snapshotPath === "controls/bun-module-confinement.js")
      ?.contents,
    Buffer.from(BUN_MODULE_CONFINEMENT_SOURCE)
  );

  const removedSchemaSnapshotPath = `modules/${moduleName}/schema/retired.schema.json`;
  assert.throws(
    () =>
      refreshedSmithersControllerSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        original: {
          ...syntheticSnapshot,
          executionFiles: [
            ...syntheticSnapshot.executionFiles,
            {
              sourcePath: path.join(packageRoot, "schema", "retired.schema.json"),
              snapshotPath: removedSchemaSnapshotPath,
              contents: Buffer.from("{}\n", "utf8")
            }
          ]
        },
        config
      }),
    /changed its sealed schema path authority/u
  );

  const bootstrapPath = path.join(packageRoot, "dist", "bootstrap.js");
  const bootstrapSnapshotPath = `modules/${moduleName}/dist/bootstrap.js`;
  fs.writeFileSync(bootstrapPath, 'import "synthetic-dependency";\nexport const bootstrap = true;\n');
  assert.throws(
    () =>
      refreshedSmithersControllerSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        original: syntheticSnapshot,
        config
      }),
    /imports synthetic-dependency outside its sealed dependency authority/u
  );

  fs.writeFileSync(bootstrapPath, 'import "./index.js";\nexport const bootstrap = true;\n');
  fs.chmodSync(bootstrapPath, 0o755);
  assert.throws(
    () =>
      refreshedSmithersControllerSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        original: syntheticSnapshot,
        config
      }),
    /changed executable authority/u
  );
  fs.chmodSync(bootstrapPath, 0o644);
  const admitted = refreshedSmithersControllerSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    original: syntheticSnapshot,
    config
  });
  assert.equal(
    admitted.snapshot.executionFiles.some((file) => file.snapshotPath === bootstrapSnapshotPath),
    true
  );

  const admittedBootstrap = admitted.snapshot.executionFiles.find(
    (file) => file.snapshotPath === bootstrapSnapshotPath
  );
  assert.ok(admittedBootstrap);
  fs.unlinkSync(bootstrapPath);
  const successor = refreshedSmithersControllerSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    original: syntheticSnapshot,
    effective: admitted.snapshot,
    config
  });
  assert.deepEqual(
    successor.snapshot.executionFiles.find((file) => file.snapshotPath === bootstrapSnapshotPath)?.contents,
    admittedBootstrap.contents,
    "a second refresh must retain a path admitted by its authenticated predecessor"
  );
  assert.throws(
    () =>
      refreshedSmithersControllerSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        original: syntheticSnapshot,
        effective: {
          ...admitted.snapshot,
          executionFiles: admitted.snapshot.executionFiles.map((file) =>
            file.snapshotPath === "controls/resolved-config.json"
              ? { ...file, contents: Buffer.concat([file.contents, Buffer.from(" ")]) }
              : file
          )
        },
        config
      }),
    /not rooted in the sealed campaign semantics/u
  );

  fs.writeFileSync(
    packageJsonPath,
    `${JSON.stringify({ name: moduleName, version: "1.0.0", dependencies: { "synthetic-dependency": "1.0.0" } })}\n`,
    "utf8"
  );
  assert.throws(
    () =>
      refreshedSmithersControllerSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        original: syntheticSnapshot,
        config
      }),
    /cannot change dependency or executable authority/u
  );

  const wrongManifest = Buffer.from(`${JSON.stringify({ name: "@ultrafuzz/wrong-controller" })}\n`, "utf8");
  fs.writeFileSync(packageJsonPath, wrongManifest);
  const wrongNameSnapshot = {
    ...syntheticSnapshot,
    executionFiles: syntheticSnapshot.executionFiles.map((file) =>
      file.snapshotPath === manifestSnapshotPath ? { ...file, contents: wrongManifest } : file
    )
  };
  assert.throws(
    () =>
      refreshedSmithersControllerSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        original: wrongNameSnapshot,
        config
      }),
    /package manifest name does not match/u
  );
  const wrongPathSnapshot = {
    ...wrongNameSnapshot,
    executionFiles: wrongNameSnapshot.executionFiles.map((file) =>
      file.snapshotPath === manifestSnapshotPath ? { ...file, sourcePath: modulePath } : file
    )
  };
  assert.throws(
    () =>
      refreshedSmithersControllerSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        original: wrongPathSnapshot,
        config
      }),
    /mismatched sealed package manifest path/u
  );
});

test("controller refresh refuses an active workflow without publishing a generation", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-active";
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId: `ultrafuzz-${runId}`,
      status: "running",
      state: "running",
      steps: [{ id: "node:project-discovery", state: "in-progress", attempt: 1 }]
    })
  });
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));

  const refreshed = await resumeRun({ projectRoot: project, runId, refreshController: true, env });

  assert.equal(refreshed.ok, false);
  assert.match(JSON.stringify(refreshed.diagnostics), /requires a stopped, terminal, or missing workflow run/u);
  assert.equal(
    fs.existsSync(path.join(launched.value!.run_root, "smithers", "controller-generation-journal.json")),
    false
  );
  assert.equal(fs.readdirSync(path.join(launched.value!.run_root, "smithers", "execution-snapshots")).length, 1);
});

test("controller refresh admits only the exact current missing-history inspect envelope", async () => {
  const project = tempProject();
  const runId = "controller-refresh-missing-history-envelope";
  const inspectPath = path.join(project, "fake-smithers-inspect.json");
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: missingSmithersInspect(path.join(project, "smithers.db"))
  });

  await assert.doesNotReject(() =>
    assertSmithersControllerRefreshable({ smithersRunId: `ultrafuzz-${runId}`, projectRoot: project, env })
  );
  fs.writeFileSync(
    inspectPath,
    `${JSON.stringify(missingSmithersInspect(path.join(project, "smithers.db"), "database"))}\n`,
    "utf8"
  );
  await assert.doesNotReject(() =>
    assertSmithersControllerRefreshable({ smithersRunId: `ultrafuzz-${runId}`, projectRoot: project, env })
  );

  const rejected = [
    {
      ...missingSmithersInspect(path.join(project, "smithers.db")),
      unexpected: true
    },
    missingSmithersInspect("relative/smithers.db"),
    {
      ...missingSmithersInspect(path.join(project, "smithers.db")),
      error: { code: "INSPECT_FAILED", message: "unrelated inspection failure" }
    },
    {
      ...missingSmithersInspect(path.join(project, "smithers.db")),
      meta: { command: "status", duration: "1ms" }
    },
    {
      ...missingSmithersInspect(path.join(project, "smithers.db")),
      error: {
        code: "INSPECT_FAILED",
        message: `No Smithers run history found at ${path.join(
          project,
          "smithers.db"
        )}. Run 'smithers up <workflow>' to start a run first.`
      }
    }
  ];
  for (const envelope of rejected) {
    fs.writeFileSync(inspectPath, `${JSON.stringify(envelope)}\n`, "utf8");
    await assert.rejects(
      () =>
        assertSmithersControllerRefreshable({
          smithersRunId: `ultrafuzz-${runId}`,
          projectRoot: project,
          env
        }),
      /exact current full-output envelope|must report ok: true/u
    );
  }
});

test("controller refresh keeps a missing-history Smithers identity instead of recreating it", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-missing-history-relaunch";
  const env = controllerRefreshTerminalEnv(project, runId);
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));
  fs.writeFileSync(
    path.join(project, "fake-smithers-inspect.json"),
    `${JSON.stringify(missingSmithersInspect(path.join(project, "smithers.db")))}\n`,
    "utf8"
  );

  const resumed = await resumeRun({ projectRoot: project, runId, refreshController: true, env });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.submitted, true);
  const upCommands = fs
    .readFileSync(env.SMITHERS_FAKE_LOG!, "utf8")
    .trim()
    .split("\n")
    .filter((command) => command.startsWith("up "));
  assert.equal(upCommands.length, 2);
  assert.match(upCommands[1]!, /\.smithers\/continuations\/[0-9a-f-]+\/workflows\//u);
  assert.match(
    upCommands[1]!,
    /--resume ultrafuzz-controller-refresh-missing-history-relaunch --run-id ultrafuzz-controller-refresh-missing-history-relaunch/u
  );
  assert.match(upCommands[1]!, /--accept-workflow-change/u);
  assert.equal(
    fs.existsSync(path.join(launched.value!.run_root, "smithers", "controller-generation-journal.json")),
    false
  );
  assert.equal(fs.existsSync(path.join(launched.value!.run_root, "smithers", "recovery-submission.json")), false);
});

test("native continuation does not use historical trusted CLI identity as an authorization gate", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-trusted-cli";
  const env = controllerRefreshTerminalEnv(project, runId);
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));
  const trustedMetadataPath = path.join(launched.value!.run_root, "trusted-cli.json");
  fs.writeFileSync(trustedMetadataPath, "{}\n", "utf8");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const ordinary = await resumeRun({ projectRoot: project, runId, env });
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary.diagnostics));
  assert.equal(ordinary.value?.submitted, true);

  const refreshed = await resumeRun({ projectRoot: project, runId, refreshController: true, env });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed.diagnostics));
  assert.equal(refreshed.value?.submitted, true);
  assert.equal(fs.readFileSync(trustedMetadataPath, "utf8"), "{}\n");
  assert.equal(
    fs
      .readFileSync(env.SMITHERS_FAKE_LOG!, "utf8")
      .trim()
      .split("\n")
      .filter((command) => command.startsWith("up ")).length,
    2
  );
});

test("controller refresh authenticates newly required sealed runner patches and rejects source drift", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "controller-refresh-runner-patches";
  const env = controllerRefreshTerminalEnv(project, runId);
  const launched = await startRun({ projectRoot: project, runId, env });
  assert.equal(launched.ok, true, JSON.stringify(launched.diagnostics));
  const evidence = await readLinkedWorkflowEvidence(project, runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const resolvedConfig = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/resolved-config.json"
  );
  const dependencyManifest = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "dependencies/manifest.json"
  );
  assert.ok(resolvedConfig);
  assert.ok(dependencyManifest);
  const config = parseResolvedConfigJsonBytes(resolvedConfig.contents);
  const dependencyMap = JSON.parse(dependencyManifest.contents.toString("utf8")) as {
    packages: Array<{ id: string; name: string; version: string; snapshot_path: string }>;
    issuers: Array<{ id: string; snapshot_path: string; dependencies: Record<string, string> }>;
  };
  assert.equal(
    dependencyMap.packages.some((entry) => entry.name === "@smthrs/engine"),
    false
  );

  const { SMITHERS_COMPATIBILITY_PATCHES } = await import("../src/smithers.js");
  const enginePatches = SMITHERS_COMPATIBILITY_PATCHES.filter(
    (candidate) => candidate.packageName === "@smthrs/engine"
  );
  const cliPatches = SMITHERS_COMPATIBILITY_PATCHES.filter((candidate) => candidate.packageName === "@smthrs/cli");
  const resumeTransferPatch = SMITHERS_COMPATIBILITY_PATCHES.find(
    (candidate) => candidate.id === "resume_snapshot_transfer"
  );
  const processAnchorPatch = SMITHERS_COMPATIBILITY_PATCHES.find(
    (candidate) => candidate.id === "process_snapshot_anchor"
  );
  assert.ok(resumeTransferPatch);
  assert.ok(processAnchorPatch);
  const [predecessorResumeTransferPatch] = resumeTransferPatch.predecessors ?? [];
  assert.ok(predecessorResumeTransferPatch);
  assert.equal(resumeTransferPatch.predecessors?.length, 1);
  const [predecessorProcessAnchorPatch, nestedProcessAnchorPatch] = processAnchorPatch.predecessors ?? [];
  assert.ok(predecessorProcessAnchorPatch);
  assert.ok(nestedProcessAnchorPatch);
  assert.equal(processAnchorPatch.predecessors?.length, 2);
  const newlyRequired = enginePatches.find((candidate) => candidate.id === "engine_refresh_path_acceptance");
  assert.ok(newlyRequired);
  const engineSequence = String(dependencyMap.packages.length + 1).padStart(6, "0");
  const enginePackageId = `package:${engineSequence}`;
  const enginePackageSnapshotPath = `dependencies/packages/${engineSequence}`;
  const cliSequence = String(dependencyMap.packages.length + 2).padStart(6, "0");
  const cliPackageId = `package:${cliSequence}`;
  const cliPackageSnapshotPath = `dependencies/packages/${cliSequence}`;
  const cliResumeSourcePath = `${cliPackageSnapshotPath}/${resumeTransferPatch.sourceRelativePath}`;
  const rootIssuer = dependencyMap.issuers.find((entry) => entry.id === "root");
  assert.ok(rootIssuer);
  const refreshedDependencyMap = {
    ...dependencyMap,
    packages: [
      ...dependencyMap.packages,
      {
        id: enginePackageId,
        name: "@smthrs/engine",
        version: SMITHERS_VERSION,
        snapshot_path: enginePackageSnapshotPath
      },
      {
        id: cliPackageId,
        name: "@smthrs/cli",
        version: SMITHERS_VERSION,
        snapshot_path: cliPackageSnapshotPath
      }
    ],
    issuers: [
      ...dependencyMap.issuers.map((entry) =>
        entry.id === "root"
          ? {
              ...entry,
              dependencies: Object.fromEntries(
                (
                  [
                    ...Object.entries(entry.dependencies),
                    ["@smthrs/engine", enginePackageId],
                    ["@smthrs/cli", cliPackageId]
                  ] as Array<[string, string]>
                ).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              )
            }
          : entry
      ),
      { id: enginePackageId, snapshot_path: enginePackageSnapshotPath, dependencies: {} },
      { id: cliPackageId, snapshot_path: cliPackageSnapshotPath, dependencies: {} }
    ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  };
  const engineSourcePath = `${enginePackageSnapshotPath}/${newlyRequired.sourceRelativePath}`;
  const engineSources = new Map<string, string>();
  for (const sourceRelativePath of new Set(enginePatches.map((candidate) => candidate.sourceRelativePath))) {
    engineSources.set(
      sourceRelativePath,
      enginePatches
        .filter((candidate) => candidate.sourceRelativePath === sourceRelativePath)
        .map((candidate) => (candidate.id === newlyRequired.id ? candidate.patchable : candidate.patched))
        .join("\n")
    );
  }
  const preFixEngineSource = engineSources.get(newlyRequired.sourceRelativePath)!;
  assert.equal(preFixEngineSource.includes(newlyRequired.patchable), true);
  assert.equal(preFixEngineSource.includes(newlyRequired.patched), false);
  const cliSources = new Map<string, string>();
  for (const sourceRelativePath of new Set(cliPatches.map((candidate) => candidate.sourceRelativePath))) {
    cliSources.set(
      sourceRelativePath,
      cliPatches
        .filter((candidate) => candidate.sourceRelativePath === sourceRelativePath)
        .map((candidate) => {
          if (candidate.id === resumeTransferPatch.id) return predecessorResumeTransferPatch;
          if (candidate.id === processAnchorPatch.id) return predecessorProcessAnchorPatch;
          return candidate.patched;
        })
        .join("\n")
    );
  }
  const syntheticExecutionFiles = [
    ...evidence.verifiedControl.executionFiles.map((file) => {
      if (file.snapshotPath === dependencyManifest.snapshotPath) {
        return {
          ...file,
          contents: Buffer.from(`${JSON.stringify(refreshedDependencyMap, null, 2)}\n`, "utf8")
        };
      }
      return file;
    }),
    {
      sourcePath: path.join(project, ".synthetic-runner", "package.json"),
      snapshotPath: `${enginePackageSnapshotPath}/package.json`,
      contents: Buffer.from(`${JSON.stringify({ name: "@smthrs/engine", version: SMITHERS_VERSION })}\n`, "utf8")
    },
    ...[...engineSources].map(([sourceRelativePath, contents]) => ({
      sourcePath: path.join(project, ".synthetic-runner", ...sourceRelativePath.split("/")),
      snapshotPath: `${enginePackageSnapshotPath}/${sourceRelativePath}`,
      contents: Buffer.from(contents, "utf8")
    })),
    {
      sourcePath: path.join(project, ".synthetic-cli", "package.json"),
      snapshotPath: `${cliPackageSnapshotPath}/package.json`,
      contents: Buffer.from(`${JSON.stringify({ name: "@smthrs/cli", version: SMITHERS_VERSION })}\n`, "utf8")
    },
    ...[...cliSources].map(([sourceRelativePath, contents]) => ({
      sourcePath: path.join(project, ".synthetic-cli", ...sourceRelativePath.split("/")),
      snapshotPath: `${cliPackageSnapshotPath}/${sourceRelativePath}`,
      contents: Buffer.from(contents, "utf8")
    }))
  ].sort((left, right) =>
    left.snapshotPath < right.snapshotPath ? -1 : left.snapshotPath > right.snapshotPath ? 1 : 0
  );
  const syntheticPreFix = { ...evidence.verifiedControl, executionFiles: syntheticExecutionFiles };

  const rebuilt = refreshedSmithersControllerSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    original: syntheticPreFix,
    config
  });
  const refreshedEngine = rebuilt.snapshot.executionFiles.find((file) => file.snapshotPath === engineSourcePath);
  assert.ok(refreshedEngine);
  assert.equal(refreshedEngine.contents.toString("utf8").includes(newlyRequired.patched), true);
  assert.equal(refreshedEngine.contents.toString("utf8").includes(newlyRequired.patchable), false);
  const refreshedCliResume = rebuilt.snapshot.executionFiles.find((file) => file.snapshotPath === cliResumeSourcePath);
  assert.ok(refreshedCliResume);
  assert.equal(refreshedCliResume.contents.toString("utf8").includes(resumeTransferPatch.patched), true);
  assert.equal(refreshedCliResume.contents.toString("utf8").includes(predecessorResumeTransferPatch), false);
  const cliIndexSourcePath = `${cliPackageSnapshotPath}/${processAnchorPatch.sourceRelativePath}`;
  const refreshedCliIndex = rebuilt.snapshot.executionFiles.find((file) => file.snapshotPath === cliIndexSourcePath);
  assert.ok(refreshedCliIndex);
  assert.equal(refreshedCliIndex.contents.toString("utf8").split(processAnchorPatch.patched).length, 2);
  assert.equal(refreshedCliIndex.contents.toString("utf8").includes(predecessorProcessAnchorPatch), false);
  assert.equal(refreshedCliIndex.contents.toString("utf8").includes(nestedProcessAnchorPatch), false);

  const nestedCliSource = {
    ...syntheticPreFix,
    executionFiles: syntheticPreFix.executionFiles.map((file) => {
      if (file.snapshotPath !== cliIndexSourcePath) return file;
      const predecessorContents = file.contents.toString("utf8");
      assert.equal(predecessorContents.split(predecessorProcessAnchorPatch).length, 2);
      return {
        ...file,
        contents: Buffer.from(
          predecessorContents.replace(predecessorProcessAnchorPatch, nestedProcessAnchorPatch),
          "utf8"
        )
      };
    })
  };
  const repairedNested = refreshedSmithersControllerSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    original: nestedCliSource,
    config
  });
  const repairedCliIndex = repairedNested.snapshot.executionFiles.find(
    (file) => file.snapshotPath === cliIndexSourcePath
  );
  assert.ok(repairedCliIndex);
  assert.equal(repairedCliIndex.contents.toString("utf8").split(processAnchorPatch.patched).length, 2);
  assert.equal(repairedCliIndex.contents.toString("utf8").includes(nestedProcessAnchorPatch), false);

  const mutatedNestedProcessAnchorPatch = nestedProcessAnchorPatch.replace(
    '"--preserve-symlinks"',
    '"--mutated-outer-startup-flag"'
  );
  assert.notEqual(mutatedNestedProcessAnchorPatch, nestedProcessAnchorPatch);
  assert.equal(mutatedNestedProcessAnchorPatch.includes(processAnchorPatch.patched), true);
  const mutatedNestedCliSource = {
    ...syntheticPreFix,
    executionFiles: syntheticPreFix.executionFiles.map((file) => {
      if (file.snapshotPath !== cliIndexSourcePath) return file;
      return {
        ...file,
        contents: Buffer.from(
          file.contents.toString("utf8").replace(predecessorProcessAnchorPatch, mutatedNestedProcessAnchorPatch),
          "utf8"
        )
      };
    })
  };
  assert.throws(
    () =>
      refreshedSmithersControllerSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        original: mutatedNestedCliSource,
        config
      }),
    /authenticated controller runner process_snapshot_anchor implementation is incompatible/u
  );

  const unknownProcessAnchorPatch = predecessorProcessAnchorPatch.replace(
    '"--preserve-symlinks"',
    '"--unregistered-startup-flag"'
  );
  assert.notEqual(unknownProcessAnchorPatch, predecessorProcessAnchorPatch);
  const unknownCliSource = {
    ...syntheticPreFix,
    executionFiles: syntheticPreFix.executionFiles.map((file) => {
      if (file.snapshotPath !== cliIndexSourcePath) return file;
      return {
        ...file,
        contents: Buffer.from(
          file.contents.toString("utf8").replace(predecessorProcessAnchorPatch, unknownProcessAnchorPatch),
          "utf8"
        )
      };
    })
  };
  assert.throws(
    () =>
      refreshedSmithersControllerSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        original: unknownCliSource,
        config
      }),
    /authenticated controller runner process_snapshot_anchor implementation is incompatible/u
  );

  const mixedCliSource = {
    ...syntheticPreFix,
    executionFiles: syntheticPreFix.executionFiles.map((file) => {
      if (file.snapshotPath !== cliResumeSourcePath) return file;
      const predecessorContents = file.contents.toString("utf8");
      assert.equal(predecessorContents.split(predecessorResumeTransferPatch).length, 2);
      return {
        ...file,
        contents: Buffer.from(
          `${predecessorContents.replace(predecessorResumeTransferPatch, resumeTransferPatch.patched)}\n${resumeTransferPatch.patchable}\n`,
          "utf8"
        )
      };
    })
  };
  assert.throws(
    () =>
      refreshedSmithersControllerSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        original: mixedCliSource,
        config
      }),
    /authenticated controller runner resume_snapshot_transfer implementation is incompatible/u
  );

  const prepared = prepareControllerGeneration(evidence.layout, syntheticPreFix, rebuilt, {
    workflowRunId: evidence.smithersRunId,
    workflowLinkId: evidence.workflowLinkId
  });
  const materialized = materializeWorkflowExecutionSnapshot({
    projectRoot: project,
    layout: evidence.layout,
    snapshot: prepared.snapshot,
    authorizedGenerations: prepared.authorizedGenerations
  });
  assert.equal(path.basename(materialized.root), prepared.controllerGeneration);
  assert.equal(
    fs
      .readFileSync(path.join(materialized.root, ...engineSourcePath.split("/")), "utf8")
      .includes(newlyRequired.patched),
    true
  );

  const drifted = {
    ...syntheticPreFix,
    executionFiles: syntheticExecutionFiles.map((file) =>
      file.snapshotPath === engineSourcePath
        ? { ...file, contents: Buffer.from("export const unrelatedRunnerShape = true;\n", "utf8") }
        : file
    )
  };
  assert.throws(
    () =>
      refreshedSmithersControllerSnapshot({
        projectRoot: project,
        layout: evidence.layout,
        original: drifted,
        config
      }),
    /authenticated controller runner .* implementation is incompatible/u
  );
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
      .replace(
        "[agents.CodexAgent]",
        '[retry]\nsame_agent_attempts = 1\nagents = ["default", "lifecycle-fallback"]\n\n[agents.CodexAgent]'
      )
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
  const sensitiveEnvironmentLog = path.join(project, "lifecycle-sensitive-environment.log");
  const hostileCredential = "must-not-cross-sealed-lifecycle-boundary";
  env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST = `${env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? ""},OPENAI_SESSION_TOKEN,SMITHERS_FAKE_SENSITIVE_ENV_LOG`;
  env.OPENAI_SESSION_TOKEN = "custom-sensitive-route-value";
  env.AWS_SECRET_ACCESS_KEY = hostileCredential;
  env.OPENAI_API_KEY = "sealed-primary-key";
  env.DEEPSEEK_API_KEY = "sealed-fallback-key";
  env.SMITHERS_FAKE_ENV_LOG = credentialLog;
  env.SMITHERS_FAKE_RETRY_CREDENTIAL_ENV_LOG = retryCredentialLog;
  env.SMITHERS_FAKE_SENSITIVE_ENV_LOG = sensitiveEnvironmentLog;
  const run = await startRun({ projectRoot: project, runId: "lifecycle-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  assert.equal(fs.readFileSync(retryCredentialLog, "utf8"), "sealed-primary-key|\n");
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  fs.writeFileSync(credentialLog, "", "utf8");
  fs.writeFileSync(retryCredentialLog, "", "utf8");
  fs.writeFileSync(sensitiveEnvironmentLog, "", "utf8");
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
  const resumeStartedAt = Date.now();
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
  assert.equal(fs.existsSync(missingPrompt.rendered_prompt_path), false);
  assert.match(fs.readFileSync(credentialLog, "utf8"), /^sealed-primary-key\|/u);
  assert.doesNotMatch(fs.readFileSync(credentialLog, "utf8"), new RegExp(hostileCredential, "u"));
  const resumedState = JSON.parse(fs.readFileSync(path.join(run.value!.run_root, "state.json"), "utf8")) as RunState;
  assert.equal(resumedState.concurrency.requested_concurrency, 8);
  assert.equal(resumedState.status, "running");
  assert.equal(resumedState.finished_at, undefined);
  assert.ok(Date.parse(resumedState.workflow_deadline_at ?? "") > resumeStartedAt);
  assert.equal(resumedState.controller_lease.status, "active");
  assert.ok(Date.parse(resumedState.controller_lease.renewed_at) >= resumeStartedAt);

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
  const sensitiveEnvironmentEntries = fs
    .readFileSync(sensitiveEnvironmentLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("|"));
  for (const command of ["replay", "fork"]) {
    assert.ok(
      sensitiveEnvironmentEntries.some(
        ([observedCommand, sensitiveNames, customValue]) =>
          observedCommand === command &&
          sensitiveNames?.split(",").includes("OPENAI_SESSION_TOKEN") &&
          customValue === "custom-sensitive-route-value"
      ),
      `${command} must receive the custom sensitive allowlist metadata and value`
    );
  }
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run --run-id ultrafuzz-lifecycle-run --force --detach --accept-workflow-change --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/
  );
  assert.match(
    commands,
    /timetravel .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run --node-id node:project-discovery --no-vcs --force --format json/
  );
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run --run-id ultrafuzz-lifecycle-run --force --detach --accept-workflow-change --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/
  );
  assert.match(commands, /replay .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run --format json/);
  assert.match(
    commands,
    /fork .*ultrafuzz-lifecycle-run\.tsx --run-id ultrafuzz-lifecycle-run-replayed --frame 44 --reset-node node:project-discovery --label after-edit --format json/
  );
  assert.match(
    commands,
    /up .*ultrafuzz-lifecycle-run\.tsx --resume ultrafuzz-lifecycle-run-forked --run-id ultrafuzz-lifecycle-run-forked --force --detach --input \{[\s\S]* --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/
  );
  const runLogsDir = path.join(run.value!.run_root, "smithers", "logs");
  assert.equal(
    commands.split(`--log-dir ${runLogsDir} `).length - 1,
    3,
    "every relaunched workflow must keep streaming into the run's own log directory"
  );
});

test(
  "native resume strips custom sensitive values from marker-less legacy controllers",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const env = fakeSmithersEnv(project);
    const capabilityDeclaration =
      'export const PROVIDER_SCOPED_SENSITIVE_ENVIRONMENT_CAPABILITY =\n  "ultrafuzz.provider-scoped-sensitive-environment.v1" as const;\n\n';
    const environmentTemplateSuffix = path.join("templates", "smithers", "agents", "environment.tsx");
    const originalReadFileSync = fs.readFileSync;
    const readFileSyncDescriptor = Object.getOwnPropertyDescriptor(fs, "readFileSync")!;
    let markerlessTemplateReads = 0;
    Object.defineProperty(fs, "readFileSync", {
      ...readFileSyncDescriptor,
      value: (...args: unknown[]) => {
        const contents = Reflect.apply(originalReadFileSync, fs, args) as string | Buffer;
        if (!String(args[0]).endsWith(environmentTemplateSuffix)) return contents;
        const source = typeof contents === "string" ? contents : contents.toString("utf8");
        assert.ok(source.includes(capabilityDeclaration));
        markerlessTemplateReads += 1;
        const markerless = source.replace(capabilityDeclaration, "");
        return typeof contents === "string" ? markerless : Buffer.from(markerless, "utf8");
      }
    });
    const run = await (async () => {
      try {
        assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
        writeSmallTopology(project);
        const started = await startRun({ projectRoot: project, runId: "markerless-legacy-lifecycle", env });
        return started;
      } finally {
        Object.defineProperty(fs, "readFileSync", readFileSyncDescriptor);
      }
    })();

    assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
    assert.ok(markerlessTemplateReads >= 2);
    const evidence = await readLinkedWorkflowEvidence(project, run.value!.run_id);
    assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
    if (evidence.ok) {
      const sealedEnvironment = evidence.verifiedControl.executionFiles.find(
        (file) => file.snapshotPath === ".smithers/agents/environment.ts"
      );
      assert.ok(sealedEnvironment);
      assert.doesNotMatch(
        sealedEnvironment.contents.toString("utf8"),
        /ultrafuzz\.provider-scoped-sensitive-environment\.v1/u
      );
    }

    const compatibleEnv = {
      ...env,
      ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "SMITHERS_FAKE_LOG"
    };
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
    const compatibleResume = await resumeRun({
      projectRoot: project,
      runId: run.value!.run_id,
      force: true,
      env: compatibleEnv
    });
    assert.equal(compatibleResume.ok, true, JSON.stringify(compatibleResume.diagnostics));
    assert.match(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /^up /mu);

    const sensitiveEnv = {
      ...env,
      ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "SMITHERS_FAKE_LOG,OPENAI_SESSION_TOKEN",
      OPENAI_SESSION_TOKEN: "custom-sensitive-route-value"
    };
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
    const eventsPath = path.join(run.value!.run_root, "events.jsonl");
    const eventsBefore = fs.readFileSync(eventsPath, "utf8");
    const resumed = await resumeRun({
      projectRoot: project,
      runId: run.value!.run_id,
      force: true,
      env: sensitiveEnv
    });
    assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
    assert.match(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /^up /mu);
    assert.equal(fs.readFileSync(eventsPath, "utf8"), eventsBefore);
    fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
    const actions = [
      ["replay", () => replayRun({ projectRoot: project, runId: run.value!.run_id, env: sensitiveEnv })],
      ["fork", () => forkRun({ projectRoot: project, runId: run.value!.run_id, forkFrame: 44, env: sensitiveEnv })]
    ] as const;
    for (const [action, submit] of actions) {
      const result = await submit();
      assert.equal(result.ok, false, `${action} unexpectedly accepted marker-less sensitive environment evidence`);
      assert.equal(result.diagnostics[0]?.code, "WORKFLOW_LIFECYCLE_FAILED");
      assert.match(
        result.diagnostics[0]?.message ?? "",
        /sealed controller predates provider-scoped sensitive allowlisted environment handling.*start a new run/u
      );
      assert.equal(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), "");
      assert.equal(fs.readFileSync(eventsPath, "utf8"), eventsBefore);
    }
  }
);

test("ordinary resume leaves required-command availability to the continued workflow", async () => {
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
  const recon = path.join(path.dirname(env.SMITHERS_BIN!), "recon-required-test");
  fs.writeFileSync(recon, "#!/bin/sh\necho recon test\n", "utf8");
  fs.chmodSync(recon, 0o755);
  const run = await startRun({ projectRoot: project, runId: "lifecycle-required-command", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.rmSync(recon);
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");
  const eventsPath = path.join(run.value!.run_root, "events.jsonl");
  const eventsBefore = fs.readFileSync(eventsPath, "utf8");

  const resumed = await resumeRun({ projectRoot: project, runId: run.value!.run_id, force: true, env });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.match(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /^up /mu);
  assert.equal(fs.readFileSync(eventsPath, "utf8"), eventsBefore);
});

test("ordinary resume bypasses legacy control-seal and link-journal gaps", async () => {
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
    const resumed = await resumeRun({ projectRoot: project, runId: entry.runId, force: true, env });
    assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
    assert.equal(resumed.value?.run_id, entry.runId);
    assert.equal(resumed.value?.workflow_run_id, `ultrafuzz-${entry.runId}`);
    assert.equal(fs.existsSync(missingPath), false, "resume must not synthesize historical authorization evidence");
    assert.match(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /--accept-workflow-change/u);
  }
});

test("ordinary resume bypasses a malformed workflow link journal without rewriting it", async () => {
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
  const resumed = await resumeRun({ projectRoot: project, runId, force: true, env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(fs.readFileSync(journalPath, "utf8"), duplicated);
  assert.match(fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8"), /--accept-workflow-change/u);
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

test("ordinary resume checks active-run ownership before detached preflight", async () => {
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
  // A duplicate `up --resume --detach` renders the workflow before Smithers
  // checks ownership. Keep that path fatal so this regression proves active
  // attachment cannot reach detached preflight.
  env.SMITHERS_FAKE_FAIL_UP = "1";

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
  assert.equal(forced.value?.submitted, false);
  const forcedCommands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(forcedCommands, /inspect ultrafuzz-active-lifecycle-run --format json --full-output/u);
  assert.doesNotMatch(forcedCommands, /^up /mu);
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

test("resume retries a failed artifact verifier from its agent producer and dependent closure", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const runId = "failed-artifact-verifier-retry";
  const workflowRunId = `ultrafuzz-${runId}`;
  const env = fakeLifecycleSmithersEnv(project, {
    inspect: workflowInspect({
      workflowRunId,
      status: "failed",
      state: "failed",
      error: { message: "the artifact verifier rejected agent-owned output" },
      steps: [
        { id: "node:project-discovery", state: "finished", attempt: 1 },
        { id: "verify:project-discovery", state: "failed", attempt: 1 }
      ]
    })
  });
  const run = await startRun({ projectRoot: project, runId, env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  fs.writeFileSync(env.SMITHERS_FAKE_LOG!, "", "utf8");

  const resumed = await resumeRun({
    projectRoot: project,
    runId,
    force: true,
    retryFailed: true,
    env
  });

  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  const commands = fs.readFileSync(env.SMITHERS_FAKE_LOG!, "utf8");
  assert.match(commands, /^timetravel .* --node-id node:project-discovery .* --force(?: |$)/mu);
  assert.doesNotMatch(commands, /^timetravel .* --node-id verify:project-discovery /mu);
  assert.doesNotMatch(
    commands,
    /^timetravel .* --node-id node:project-discovery .* --no-deps(?: |$)/mu,
    "the producer retry must also reset its zero-retry verifier and downstream dependents"
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
    /up .*ultrafuzz-terminal-row-retry-run\.tsx --resume ultrafuzz-terminal-row-retry-run --run-id ultrafuzz-terminal-row-retry-run --force --detach --accept-workflow-change --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/u
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
    /up .*ultrafuzz-render-recovery-run\.tsx --resume ultrafuzz-render-recovery-run --run-id ultrafuzz-render-recovery-run --force --detach --accept-workflow-change --max-concurrency 8 --log-dir \S+\/smithers\/logs --format json/u
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
    /up .*ultrafuzz-reset-lifecycle-run\.tsx --resume ultrafuzz-reset-lifecycle-run --run-id ultrafuzz-reset-lifecycle-run --force --detach --accept-workflow-change( --max-concurrency \d+)? --log-dir \S+\/smithers\/logs --format json/u
  );
});

testWhen(realSmithersGraphUnavailable() === false)(
  "compiled Smithers workflow passes a real non-executing graph smoke",
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
